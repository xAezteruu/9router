// Bundled Tor daemon manager — ships a native Tor binary via the
// `kmp-tor.resource-exec-tor.linux-libc` npm package (no apt install needed).
// On first use the binary is extracted to DATA_DIR/bin/tor/ and spawned as a
// long-lived SOCKS5 proxy on 127.0.0.1:9051 (non-standard port: never collides
// with a system tor on 9050). App proxy pools can then use socks5://127.0.0.1:9051.
import fs from "fs";
import path from "path";
import os from "os";
import net from "net";
import { spawn } from "child_process";
import { DATA_DIR } from "@/lib/dataDir.js";

const TOR_DIR = path.join(DATA_DIR, "bin", "tor");
const TOR_BIN = path.join(TOR_DIR, "tor");
const TOR_LIB_DIR = path.join(TOR_DIR, "lib");
const TOR_SOCKS_PORT = 9051;
const TOR_CONTROL_PORT = 9052;

let torProcess = null;
let startPromise = null;

// Package layout: kmp-tor ships per-arch gzip'd binaries. Extract on demand —
// npm keeps .gz files because executable permissions don't survive tarball round-trips.
const PACKAGE_NAME = "kmp-tor.resource-exec-tor.linux-libc";

function archDir() {
  // node arch → package dir naming
  const arch = os.arch();
  if (arch === "x64") return "x86_64";
  if (arch === "ia32") return "x86";
  if (arch === "arm64") return "aarch64";
  if (arch === "arm") return "arm";
  return arch;
}

function findPackageDir() {
  // Works both when 9router is a node_modules dep and when run from source
  const candidates = [
    path.join(process.cwd(), "node_modules", PACKAGE_NAME),
    path.join(process.cwd(), "..", "node_modules", PACKAGE_NAME),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, archDir(), "tor.gz"))) return dir;
  }
  return null;
}

function extractBinary() {
  const src = findPackageDir();
  if (!src) {
    throw new Error(
      `Bundled Tor package "${PACKAGE_NAME}" not found in node_modules. ` +
      `Install it (npm i ${PACKAGE_NAME}) or use a system tor on port 9050 instead.`
    );
  }
  const { execSync } = require("child_process");
  fs.mkdirSync(TOR_DIR, { recursive: true });
  fs.mkdirSync(TOR_LIB_DIR, { recursive: true });

  const arch = archDir();
  execSync(`gzip -dc "${path.join(src, arch, "tor.gz")}" > "${TOR_BIN}.tmp" && chmod 755 "${TOR_BIN}.tmp" && mv "${TOR_BIN}.tmp" "${TOR_BIN}"`, { stdio: "pipe" });
  execSync(`gzip -dc "${path.join(src, arch, "libtor.so.gz")}" > "${path.join(TOR_LIB_DIR, "libtor.so")}"`, { stdio: "pipe" });
  console.log("[Tor] extracted bundled binary to", TOR_DIR);
}

function isExtracted() {
  try {
    fs.accessSync(TOR_BIN, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function portOpen(port, host = "127.0.0.1", timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export function isBundledTorRunning() {
  return torProcess !== null && torProcess.exitCode === null;
}

export async function isBundledTorPortOpen() {
  return portOpen(TOR_SOCKS_PORT);
}

/**
 * Start the bundled Tor daemon (idempotent).
 * Returns { started, port } — started=false when something else already owns the port.
 */
export async function startBundledTor() {
  if (isBundledTorRunning()) return { started: true, port: TOR_SOCKS_PORT, alreadyRunning: true };
  if (startPromise) return startPromise;
  startPromise = _start().finally(() => { startPromise = null; });
  return startPromise;
}

async function _start() {
  if (await isBundledTorPortOpen()) {
    // Something already serves SOCKS on our port — treat as running (e.g. app restart
    // left the old daemon alive).
    return { started: false, port: TOR_SOCKS_PORT, alreadyRunning: true };
  }

  if (!isExtracted()) extractBinary();

  fs.mkdirSync(path.join(DATA_DIR, "tor", "data"), { recursive: true });
  const config = [
    `SocksPort ${TOR_SOCKS_PORT}`,
    `ControlPort ${TOR_CONTROL_PORT}`,
    `DataDirectory ${path.join(DATA_DIR, "tor", "data")}`,
    "Log notice",
    // Client-only node: never relay traffic for others. NOTE: no SOCKSPolicy —
    // a `reject *:*` SOCKSPolicy refuses ALL client connections too (the SOCKS
    // port itself counts as traffic), which breaks every SOCKS handshake.
  ].join("\n");
  const configPath = path.join(DATA_DIR, "tor", "torrc");
  fs.writeFileSync(configPath, config + "\n", "utf8");

  const child = spawn(TOR_BIN, ["-f", configPath], {
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LD_LIBRARY_PATH: TOR_LIB_DIR },
    windowsHide: true,
  });
  torProcess = child;
  child.on("exit", (code) => {
    console.warn(`[Tor] daemon exited (code=${code})`);
    torProcess = null;
  });

  // Wait until the SOCKS port answers (tor bootstraps in 5–30s, but SOCKS
  // binds early — first circuit builds lazily per connection).
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Tor daemon exited during startup (code=${child.exitCode})`);
    if (await portOpen(TOR_SOCKS_PORT)) {
      console.log(`[Tor] SOCKS proxy ready on 127.0.0.1:${TOR_SOCKS_PORT}`);
      return { started: true, port: TOR_SOCKS_PORT };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Tor SOCKS port did not open within 30s");
}

export function stopBundledTor() {
  if (torProcess) {
    try { torProcess.kill(); } catch { /* ignore */ }
    torProcess = null;
  }
}

export { TOR_SOCKS_PORT, TOR_BIN };
