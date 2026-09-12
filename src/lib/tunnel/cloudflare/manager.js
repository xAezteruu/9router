import { loadState, saveState, generateShortId } from "../shared/state.js";
import { spawnQuickTunnel, spawnCloudflared, killCloudflared, isCloudflaredRunning, setUnexpectedExitHandler } from "./cloudflared.js";
import { encryptSecret, decryptSecret } from "../secretStore.js";
import { clearPid } from "./pid.js";
import { waitForHealth, probeUrlAlive } from "./healthCheck.js";
import { WORKER_URL } from "./config.js";
import { getSettings, updateSettings } from "@/lib/localDb";

const svc = {
  cancelToken: { cancelled: false },
  spawnInProgress: false,
  lastRestartAt: 0,
  activeLocalPort: null,
  activeMode: "quick",
  tunnelToken: null,
};

export function getTunnelService() { return svc; }
export function isTunnelManuallyDisabled() { return svc.cancelToken.cancelled; }
export function isTunnelReconnecting() { return svc.spawnInProgress; }

let onUnexpectedExit = null;
export function setTunnelUnexpectedExitCallback(cb) { onUnexpectedExit = cb; }

async function registerTunnelUrl(shortId, tunnelUrl) {
  // Registration is the linchpin of the public URL — a silent failure leaves the
  // worker pointing at a dead tunnel while the UI hangs on "Creating". Retry with
  // backoff, then surface the failure so enable fails loudly instead of hanging.
  const maxAttempts = 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${WORKER_URL}/api/tunnel/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shortId, tunnelUrl }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return;
      lastErr = new Error(`register responded ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    console.warn(`[Tunnel] register attempt ${attempt}/${maxAttempts} failed: ${lastErr.message}`);
    if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  throw new Error(`Tunnel registration failed after ${maxAttempts} attempts: ${lastErr?.message || "unknown"}`);
}

function throwIfCancelled(token) {
  if (token.cancelled) throw new Error("tunnel cancelled");
}

export async function enableTunnel(localPort = parseInt(process.env.PORT || "20128", 10), { tunnelToken = null, waitHealth = true, settingsRef = null } = {}) {
  console.log(`[Tunnel] enable start (port=${localPort}, mode=${tunnelToken ? "token" : "quick"})`);
  svc.cancelToken = { cancelled: false };
  svc.activeLocalPort = localPort;
  svc.spawnInProgress = true;
  svc.activeMode = tunnelToken ? "token" : "quick";
  svc.tunnelToken = tunnelToken;
  const token = svc.cancelToken;

  // ── Token mode: named tunnel via user's own Cloudflare account ──
  // The token embeds the tunnel ID; cloudflared routes your hostname directly.
  // No trycloudflare shortener, no worker registration involved. The token is
  // encrypted (machine-key AES-256-GCM) and persisted so the tunnel auto-starts
  // on restart — same pattern as mitmSudoEncrypted.
  if (tunnelToken) {
    try {
      killCloudflared(localPort);
      throwIfCancelled(token);
      setUnexpectedExitHandler(() => {
        console.warn("[Tunnel] cloudflared exited unexpectedly, scheduling respawn");
        if (onUnexpectedExit) onUnexpectedExit();
      });
      const child = await spawnCloudflared(tunnelToken);
      throwIfCancelled(token);
      const state = loadState();
      const shortId = state?.shortId || generateShortId();
      saveState({ shortId, tunnelUrl: `token:${child.pid}` });
      await updateSettings({
        tunnelEnabled: true,
        tunnelToken: true,
        tunnelTokenEncrypted: encryptSecret(tunnelToken),
      });
      console.log(`[Tunnel] token tunnel running (pid=${child.pid}), token saved for auto-restart`);
      return { success: true, mode: "token", alreadyRunning: false };
    } catch (e) {
      if (!/cloudflared killed|tunnel cancelled/.test(e.message)) {
        console.error(`[Tunnel] token enable error: ${e.message}`);
      }
      throw e;
    } finally {
      svc.spawnInProgress = false;
    }
  }

  // ── Quick mode: trycloudflare.com ephemeral URL (existing behavior) ──
  // NOTE: if tunnelToken mode was previously saved, prefer restoring it — a
  // restart (auto-resume / watchdog) must bring back the user's named tunnel,
  // not silently downgrade to an ephemeral quick URL.
  try {
    const savedToken = settingsRef?.tunnelTokenEncrypted ? decryptSecret(settingsRef.tunnelTokenEncrypted) : null;
    if (savedToken) {
      console.log("[Tunnel] saved token found — restoring token tunnel instead of quick");
      return enableTunnel(localPort, { tunnelToken: savedToken, waitHealth });
    }
    if (isCloudflaredRunning()) {
      const existing = loadState();
      if (existing?.tunnelUrl && existing?.shortId) {
        const publicUrl = `https://r${existing.shortId}.abc-tunnel.us`;
        // Reuse only if BOTH direct + public URL alive (avoid stale socket after network change)
        const [directOk, publicOk] = await Promise.all([
          probeUrlAlive(existing.tunnelUrl),
          probeUrlAlive(publicUrl),
        ]);
        if (directOk && publicOk) {
          console.log(`[Tunnel] already running, reuse: ${existing.tunnelUrl}`);
          return { success: true, tunnelUrl: existing.tunnelUrl, shortId: existing.shortId, publicUrl, alreadyRunning: true };
        }
        console.log(`[Tunnel] stale (direct=${directOk} public=${publicOk}), respawn`);
      }
    }

    killCloudflared(localPort);
    console.log("[Tunnel] killed existing cloudflared");
    throwIfCancelled(token);

    const existing = loadState();
    const shortId = existing?.shortId || generateShortId();
    const publicUrl = `https://r${shortId}.abc-tunnel.us`;

    // Heal a stale public URL up-front: if the worker still routes shortId to a
    // dead tunnel, subsequent health checks would 530 no matter how long we wait.
    // A pre-register with the (new) direct URL is harmless when nothing is stale —
    // the authoritative register happens after spawn anyway.
    try {
      await registerTunnelUrl(shortId, `https://${shortId}-pending.abc-tunnel.us`);
      console.log(`[Tunnel] pre-cleared stale worker mapping for ${shortId}`);
    } catch (e) {
      console.warn(`[Tunnel] pre-clear skipped: ${e.message}`);
    }
    throwIfCancelled(token);

    const onUrlUpdate = async (url) => {
      if (token.cancelled) return;
      console.log(`[Tunnel] url updated: ${url}`);
      await registerTunnelUrl(shortId, url);
      saveState({ shortId, tunnelUrl: url });
      await updateSettings({ tunnelEnabled: true, tunnelUrl: url });
    };

    // Register exit handler BEFORE spawn so it fires even on early exit
    setUnexpectedExitHandler(() => {
      console.warn("[Tunnel] cloudflared exited unexpectedly, scheduling respawn");
      if (onUnexpectedExit) onUnexpectedExit();
    });

    const { tunnelUrl } = await spawnQuickTunnel(localPort, onUrlUpdate);
    console.log(`[Tunnel] spawned: ${tunnelUrl}`);
    throwIfCancelled(token);

    await registerTunnelUrl(shortId, tunnelUrl);
    saveState({ shortId, tunnelUrl });
    await updateSettings({ tunnelEnabled: true, tunnelUrl });
    console.log(`[Tunnel] registered shortId=${shortId} publicUrl=${publicUrl}`);

    // Verify publicUrl first (worker route is reliable; direct *.trycloudflare.com DNS may lag)
    if (waitHealth) {
      await waitForHealth(publicUrl, token);
      console.log("[Tunnel] public URL healthy");
      // Direct tunnel probe is best-effort: DNS for *.trycloudflare.com can be slow/blocked
      if (!(await probeUrlAlive(tunnelUrl))) {
        console.warn("[Tunnel] direct URL not reachable yet, continuing via publicUrl");
      } else {
        console.log("[Tunnel] direct URL healthy");
      }
    } else {
      // API callers probe /api/tunnel/status from the client — don't hold the
      // HTTP request hostage for up to a minute after the tunnel is already up.
      console.log("[Tunnel] skipping blocking health wait (client probes instead)");
    }

    console.log("[Tunnel] enable success");
    return { success: true, tunnelUrl, shortId, publicUrl };
  } catch (e) {
    // Suppress noise when spawn was deliberately killed (restart/disable superseded it)
    if (!/cloudflared killed|tunnel cancelled/.test(e.message)) {
      console.error(`[Tunnel] enable error: ${e.message}`);
    }
    throw e;
  } finally {
    svc.spawnInProgress = false;
  }
}

export async function disableTunnel() {
  console.log("[Tunnel] disable");
  // Abort any in-flight enable so it cannot resurrect state after we clear it
  svc.cancelToken.cancelled = true;
  setUnexpectedExitHandler(null);

  try { killCloudflared(svc.activeLocalPort); } catch (e) { console.warn(`[Tunnel] kill warn: ${e.message}`); }
  clearPid();

  const state = loadState();
  if (state) saveState({ shortId: state.shortId, tunnelUrl: null });

  await updateSettings({ tunnelEnabled: false, tunnelUrl: "", tunnelToken: false, tunnelTokenEncrypted: null });
  // Force-clear flags so a subsequent enable is not blocked by a stuck spawnInProgress
  svc.spawnInProgress = false;
  svc.activeLocalPort = null;
  svc.activeMode = "quick";
  svc.tunnelToken = null;
  return { success: true };
}

export async function getTunnelStatus() {
  const settings = await getSettings();
  const settingsEnabled = settings.tunnelEnabled === true;
  const state = loadState();
  const shortId = state?.shortId || "";
  const isTokenMode = settings.tunnelToken === true;
  const publicUrl = shortId && !isTokenMode ? `https://r${shortId}.abc-tunnel.us` : "";
  const tunnelUrl = isTokenMode ? "" : (state?.tunnelUrl || "");

  // Lazy: skip PID probe entirely when user disabled tunnel
  const running = settingsEnabled ? isCloudflaredRunning() : false;

  return {
    enabled: settingsEnabled && running,
    settingsEnabled,
    mode: isTokenMode ? "token" : "quick",
    tunnelUrl,
    shortId,
    publicUrl,
    running
  };
}
