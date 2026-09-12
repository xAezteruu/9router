// Auto-provision the bundled Tor proxy pool: extract + start the daemon on
// 127.0.0.1:9051 (if not already up), then create a "Tor (bundled)" proxy pool
// entry so users get Tor without any manual setup. Idempotent + best-effort:
// never throws — failures are logged and returned for status display.
import { startBundledTor, isBundledTorRunning, TOR_SOCKS_PORT } from "./bundledTor.js";
import { createProxyPool, getProxyPools } from "@/models";

export const TOR_POOL_NAME = "Tor (bundled)";

/**
 * Ensure the bundled-Tor pool exists and the daemon is running.
 * Returns { ok, pool|null, reason? } — never throws.
 */
export async function ensureTorPool() {
  try {
    const pools = await getProxyPools();
    const existing = pools.find((p) => p.proxyUrl?.includes(`:${TOR_SOCKS_PORT}`));
    if (existing) {
      // Pool exists — just make sure the daemon is up (cheap when already running)
      if (!isBundledTorRunning()) {
        await startBundledTor().catch(() => {});
      }
      return { ok: true, pool: existing };
    }

    await startBundledTor();
    const pool = await createProxyPool({
      name: TOR_POOL_NAME,
      proxyUrl: `socks5://127.0.0.1:${TOR_SOCKS_PORT}`,
      type: "http",
      isActive: true,
      strictProxy: false,
      testStatus: "active",
    });
    console.log(`[Tor] auto-created proxy pool "${TOR_POOL_NAME}" (socks5://127.0.0.1:${TOR_SOCKS_PORT})`);
    return { ok: true, pool };
  } catch (e) {
    console.warn(`[Tor] auto-provision failed: ${e.message}`);
    return { ok: false, pool: null, reason: e.message };
  }
}
