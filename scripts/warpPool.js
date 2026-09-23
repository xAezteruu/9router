// Warp Pool — auto-rotate WARP proxy per request via warp-rotate
// Uses SOCKS5 proxy on port 40000, rotates IP before each request

import { spawn } from "child_process";

const WARP_SOCKS5 = "socks5://127.0.0.1:40000";
const WARP_ROTATE_CMD = "/usr/local/bin/warp-rotate";
const ROTATE_COOLDOWN_MS = 5000; // min time between rotates

let lastRotateTime = 0;

/**
 * Wait for ms
 * @param {number} ms
 * @returns {Promise<void>}
 */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Rotate WARP IP if cooldown passed
 * @returns {Promise<void>}
 */
async function rotateWarpIfNeeded() {
  const now = Date.now();
  if (now - lastRotateTime > ROTATE_COOLDOWN_MS) {
    lastRotateTime = now;
    return new Promise((resolve, reject) => {
      const proc = spawn(WARP_ROTATE_CMD, ["rotate"], { stdio: "pipe" });
      let output = "";
      proc.stdout.on("data", (d) => (output += d.toString()));
      proc.stderr.on("data", (d) => (output += d.toString()));
      proc.on("exit", (code) => {
        if (code === 0) {
          console.log(`[WarpPool] WARP IP rotated: ${output.trim()}`);
          resolve();
        } else {
          console.warn(`[WarpPool] Rotate failed (code ${code}): ${output}`);
          resolve(); // Fail open
        }
      });
    });
  }
}

/**
 * Get current WARP SOCKS5 URL (for fallback)
 */
function getProxyUrl() {
  return WARP_SOCKS5;
}

/**
 * Rotate WARP proxy and return fresh proxy URL
 */
export async function getFreshProxyUrl() {
  await rotateWarpIfNeeded();
  // Wait a bit for proxy to be ready after rotate
  await wait(500);
  return WARP_SOCKS5;
}

export default {
  getProxyUrl,
  getFreshProxyUrl,
  rotateWarpIfNeeded,
};
