import { NextResponse } from "next/server";
import { enableTunnel } from "@/lib/tunnel";
import { getSettings } from "@/lib/localDb";
import { configureTunnelMonitoring } from "@/shared/services/initializeApp";

const DNS_WARMUP_DELAY_MS = 8000;

export async function POST(request) {
  try {
    let tunnelToken = null;
    try {
      const body = await request.json();
      // Token mode: user's own named tunnel (cloudflared tunnel run --token).
      // Empty/whitespace string falls back to quick mode.
      if (typeof body?.tunnelToken === "string" && body.tunnelToken.trim()) {
        tunnelToken = body.tunnelToken.trim();
      }
    } catch { /* no body → quick mode */ }

    // settingsRef lets enableTunnel restore a previously-saved token tunnel on
    // auto-restart (watchdog/startup) without the caller passing the token again.
    const settings = await getSettings();
    const result = await enableTunnel(undefined, { tunnelToken, waitHealth: false, settingsRef: settings });
    getSettings()
      .then(configureTunnelMonitoring)
      .catch((error) => console.warn("Tunnel monitor start failed:", error.message));
    if (result.mode === "token") {
      // Token tunnels host the user's own hostname — no trycloudflare DNS warmup needed
      return NextResponse.json(result);
    }
    // DNS warmup stays short: the UI now reconciles state by polling /api/tunnel/status
    await new Promise((r) => setTimeout(r, DNS_WARMUP_DELAY_MS));
    return NextResponse.json(result);
  } catch (error) {
    console.error("Tunnel enable error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
