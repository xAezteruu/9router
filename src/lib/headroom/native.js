// Native bundled Headroom — one-click install + run of the Headroom proxy
// inside an app-managed Python venv (DATA_DIR/headroom/venv). No manual
// `pip install` needed: on first enable, this module
//   1. finds a Python >= 3.10 interpreter (existing detect.js helpers)
//   2. creates a venv at DATA_DIR/headroom/venv (bootstraps pip if missing)
//   3. `pip install headroom-ai[proxy]` into that venv
//   4. spawns `headroom proxy --port <port>` from the venv's CLI
// The proxy then answers the same HTTP contract (POST /v1/compress) that
// open-sse/rtk/headroom.js already expects, so mode "native" needs zero
// changes to the compression pipeline. External-URL mode is unchanged.
import fs from "fs";
import path from "path";
import net from "net";
import { execFile, spawn } from "child_process";
import { DATA_DIR } from "@/lib/dataDir.js";
import { findPython310 } from "./detect.js";

const VENV_DIR = path.join(DATA_DIR, "headroom", "venv");
const VENV_PY = process.platform === "win32" ? path.join(VENV_DIR, "Scripts", "python.exe") : path.join(VENV_DIR, "bin", "python");
const VENV_CLI = process.platform === "win32" ? path.join(VENV_DIR, "Scripts", "headroom.exe") : path.join(VENV_DIR, "bin", "headroom");

let installPromise = null;

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

export function isNativeHeadroomInstalled() {
  return fs.existsSync(VENV_CLI);
}

function run(py, args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    execFile(py, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr: String(stderr).slice(-2000) }));
      resolve(String(stdout));
    });
  });
}

// Create the venv and install headroom-ai[proxy] into it. Idempotent: skips
// steps that are already done. Safe to call repeatedly.
export async function installNativeHeadroom({ onProgress = null } = {}) {
  if (isNativeHeadroomInstalled()) return { installed: true, alreadyInstalled: true };
  if (installPromise) return installPromise;

  installPromise = (async () => {
    const py = findPython310();
    if (!py) {
      const err = new Error("Python >= 3.10 not found — install Python 3.10+ or use external Headroom URL mode");
      err.code = "NO_PYTHON";
      throw err;
    }

    onProgress?.("Creating Python virtual environment...");
    if (!fs.existsSync(VENV_PY)) {
      try {
        await run(py, ["-m", "venv", VENV_DIR]);
      } catch (e) {
        // Debian/Ubuntu often ship python3 without ensurepip (python3-venv).
        // Bootstrap pip inside the venv via get-pip.py, then retry.
        onProgress?.("Bootstrapping pip (python3-venv incomplete)...");
        await run(py, ["-m", "venv", "--without-pip", VENV_DIR]);
        await run(VENV_PY, [path.join(DATA_DIR, "headroom", "get-pip.py")], 180_000).catch(async () => {
          const script = await fetch("https://bootstrap.pypa.io/get-pip.py").then((r) => r.text());
          fs.writeFileSync(path.join(DATA_DIR, "headroom", "get-pip.py"), script);
          await run(VENV_PY, [path.join(DATA_DIR, "headroom", "get-pip.py")], 180_000);
        });
      }
    }

    onProgress?.("Installing headroom-ai[proxy] (this can take a few minutes)...");
    await run(VENV_PY, ["-m", "pip", "install", "--upgrade", "headroom-ai[proxy]"], 600_000);

    if (!fs.existsSync(VENV_CLI)) throw new Error("headroom CLI missing after install");
    return { installed: true, cli: VENV_CLI };
  })().finally(() => { installPromise = null; });

  return installPromise;
}

export { VENV_DIR, VENV_PY, VENV_CLI };
