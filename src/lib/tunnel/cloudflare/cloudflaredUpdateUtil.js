// Shared internals for cloudflared.js and cloudflaredUpdater.js.
// Lives separately to avoid a circular import: cloudflared.js imports nothing
// from here at runtime beyond these helpers.
import fs from "fs";
import path from "path";
import https from "https";
import os from "os";
import { execSync, execFile } from "child_process";
import { DATA_DIR } from "@/lib/dataDir.js";

export const BIN_DIR = path.join(DATA_DIR, "bin");
export const BINARY_NAME = "cloudflared";
export const IS_WINDOWS = os.platform() === "win32";
export const BIN_NAME = IS_WINDOWS ? `${BINARY_NAME}.exe` : BINARY_NAME;
export const BIN_PATH = path.join(BIN_DIR, BIN_NAME);

// Package-provided binary (npm `cloudflared`): the preferred native source —
// installed/updated with `npm install`, no apt, no manual download. Falls back
// to DATA_DIR copy (legacy manual installs) when the package is absent.
function npmPackageBin() {
  try {
    const pkgBin = path.join(process.cwd(), "node_modules", "cloudflared", "bin", IS_WINDOWS ? "cloudflared.exe" : "cloudflared");
    if (fs.existsSync(pkgBin)) return pkgBin;
    // When 9router itself lives inside node_modules
    const nested = path.join(process.cwd(), "..", "node_modules", "cloudflared", "bin", IS_WINDOWS ? "cloudflared.exe" : "cloudflared");
    if (fs.existsSync(nested)) return nested;
  } catch { /* ignore */ }
  return null;
}

// Resolve the cloudflared binary to execute. Priority: npm package binary
// (native, versioned with the app) → DATA_DIR binary (legacy download) → null.
export function resolveCloudflaredBin() {
  return npmPackageBin() || (fs.existsSync(BIN_PATH) ? BIN_PATH : null);
}

export function deletePidSafe() {
  try {
    // Imported lazily to avoid cycle with pid.js
    const pidModule = require("./pid.js");
    pidModule.clearPid();
  } catch { /* ignore */ }
}

export function isValidBinaryShared(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < 1024 * 1024) return false;
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    const magic = buf.toString("hex");
    if (IS_WINDOWS) return magic.startsWith("4d5a");
    if (os.platform() === "darwin") return magic.startsWith("cffaedfe") || magic.startsWith("cefaedfe");
    return magic.startsWith("7f454c46");
  } catch {
    return false;
  }
}

export const isValidBinary = isValidBinaryShared;

// Read the installed binary's version (`cloudflared --version`), null when absent/broken.
// Resolves the npm package binary first (native source of truth), then the DATA_DIR copy.
export function getInstalledCloudflaredVersion() {
  const binPath = resolveCloudflaredBin();
  if (!binPath) return Promise.resolve(null);
  if (!isValidBinaryShared(binPath)) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(binPath, ["--version"], { timeout: 10_000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const m = String(stdout || "").match(/(\d{4}\.\d+\.\d+|\d+\.\d+\.\d+)/);
      resolve(m ? m[1] : null);
    });
  });
}

// Download latest binary for this platform from the upstream GitHub release.
// Overwrites the existing binary in place (tmp + rename).
export async function runDownload({ force = false } = {}) {
  const PLATFORM_MAPPINGS = {
    darwin: { x64: "cloudflared-darwin-amd64.tgz", arm64: "cloudflared-darwin-arm64.tgz" },
    win32: { x64: "cloudflared-windows-amd64.exe", ia32: "cloudflared-windows-386.exe", arm64: "cloudflared-windows-386.exe" },
    linux: { x64: "cloudflared-linux-amd64", arm64: "cloudflared-linux-arm64" },
  };
  const FALLBACK = { darwin: "cloudflared-darwin-amd64.tgz", win32: "cloudflared-windows-386.exe", linux: "cloudflared-linux-amd64" };

  const platform = os.platform();
  const arch = os.arch();
  const mapping = PLATFORM_MAPPINGS[platform];
  if (!mapping) throw new Error(`Unsupported platform: ${platform}`);
  const asset = mapping[arch] || FALLBACK[platform];
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;

  if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

  const isArchive = url.endsWith(".tgz");
  const tmpPath = path.join(BIN_DIR, `${BINARY_NAME}.update.tmp`);
  const downloadDest = isArchive ? path.join(BIN_DIR, "cloudflared.update.tgz") : tmpPath;
  if (fs.existsSync(downloadDest)) { try { fs.unlinkSync(downloadDest); } catch {} }

  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(downloadDest);
    const get = (u) => {
      https.get(u, { headers: { "User-Agent": "9router-updater" } }, (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.resume();
          return get(response.headers.location);
        }
        if (response.statusCode !== 200) {
          file.close();
          try { fs.unlinkSync(downloadDest); } catch {}
          return reject(new Error(`Download failed with status ${response.statusCode}`));
        }
        response.pipe(file);
        file.on("finish", () => file.close((err) => (err ? reject(err) : resolve())));
        file.on("error", (err) => { try { fs.unlinkSync(downloadDest); } catch {} reject(err); });
      }).on("error", (err) => {
        file.close();
        try { fs.unlinkSync(downloadDest); } catch {}
        reject(err);
      });
    };
    get(url);
  });

  if (isArchive) {
    execSync(`tar -xzf "${downloadDest}" -C "${BIN_DIR}"`, { stdio: "pipe", windowsHide: true });
    // Archive extracts as `cloudflared` — move to final name if needed
    const extracted = path.join(BIN_DIR, IS_WINDOWS ? "cloudflared.exe" : "cloudflared");
    if (path.resolve(extracted) !== path.resolve(BIN_PATH) && fs.existsSync(extracted)) {
      fs.renameSync(extracted, BIN_PATH);
    }
    fs.unlinkSync(downloadDest);
  } else {
    fs.renameSync(downloadDest, BIN_PATH);
  }

  if (!IS_WINDOWS) fs.chmodSync(BIN_PATH, "755");
  return BIN_PATH;
}
