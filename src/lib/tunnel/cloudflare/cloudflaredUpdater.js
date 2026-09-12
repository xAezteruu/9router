// Cloudflared binary updater (Node.js) — pulls the latest release straight from
// the upstream GitHub repo (cloudflare/cloudflared). Reuses the download/extract
// primitives from cloudflared.js so checksums of behavior stay identical.
import fs from "fs";
import { deletePidSafe } from "./cloudflaredUpdateUtil.js";
import { runDownload, BIN_PATH, isValidBinary, IS_WINDOWS } from "./cloudflaredUpdateUtil.js";

const GITHUB_LATEST_API = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest";
const GITHUB_TAG_URL = "https://github.com/cloudflare/cloudflared/releases/latest";

// Read the currently installed binary's version, null when absent/broken.
// (Implementation lives in cloudflaredUpdateUtil.js — single source of truth.)
import { getInstalledCloudflaredVersion } from "./cloudflaredUpdateUtil.js";

// Latest release tag from the main GitHub repo (API first, HTML fallback).
export async function getLatestCloudflaredVersion() {
  try {
    const res = await fetch(GITHUB_LATEST_API, {
      headers: { "User-Agent": "9router-updater", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const data = await res.json();
      const tag = String(data.tag_name || "").replace(/^v/, "");
      if (tag) return { version: tag, publishedAt: data.published_at || null };
    }
  } catch { /* fall through to HTML fallback */ }
  // Fallback: follow the /latest redirect and read the tag from the URL
  const res = await fetch(GITHUB_TAG_URL, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
  const finalUrl = res.url || "";
  const m = finalUrl.match(/tag\/v?(\d{4}\.\d+\.\d+|\d+\.\d+\.\d+)/);
  if (!m) throw new Error(`Could not determine latest cloudflared version (final URL: ${finalUrl})`);
  return { version: m[1], publishedAt: null };
}

function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Check for update only. { current, latest, updateAvailable }
export async function checkCloudflaredUpdate() {
  const [current, latestInfo] = await Promise.all([
    getInstalledCloudflaredVersion(),
    getLatestCloudflaredVersion(),
  ]);
  return {
    current,
    latest: latestInfo.version,
    publishedAt: latestInfo.publishedAt,
    updateAvailable: !current || compareVersions(latestInfo.version, current) > 0,
  };
}

// Download (or re-download) the latest binary and swap it in. Stops a running
// cloudflared first — the watchdog/monitor will restart the tunnel with the new binary.
export async function updateCloudflared({ force = false } = {}) {
  const status = await checkCloudflaredUpdate();
  if (!force && !status.updateAvailable) {
    return { updated: false, ...status };
  }

// Stop a running tunnel so the file lock (Windows) releases and the new
// binary takes effect; watchdog restarts it afterwards.
let killFn = null;
try { killFn = (await import("./cloudflared.js")).killCloudflared; } catch { /* best effort */ }
try {
  if (killFn) killFn();
  const { clearPid } = await import("./pid.js");
  clearPid();
} catch { /* best effort */ }

  await runDownload({ force: true });

  const installed = await getInstalledCloudflaredVersion();
  return { updated: true, previous: status.current, current: installed, latest: status.latest };
}
