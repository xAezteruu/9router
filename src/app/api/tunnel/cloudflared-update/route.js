import { NextResponse } from "next/server";
import { checkCloudflaredUpdate, updateCloudflared } from "@/lib/tunnel";

export const dynamic = "force-dynamic";

/**
 * GET /api/tunnel/cloudflared-update
 * Compare installed cloudflared vs latest release on github.com/cloudflare/cloudflared.
 */
export async function GET() {
  try {
    const status = await checkCloudflaredUpdate();
    return NextResponse.json(status);
  } catch (error) {
    console.error("cloudflared update check failed:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * POST /api/tunnel/cloudflared-update
 * Download the latest binary from GitHub and swap it in.
 * Body: { force?: boolean } — force reinstalls even when up-to-date.
 * A running tunnel is stopped; the watchdog restarts it with the new binary.
 */
export async function POST(request) {
  try {
    let force = false;
    try {
      const body = await request.json();
      force = body?.force === true;
    } catch { /* empty body ok */ }
    const result = await updateCloudflared({ force });
    return NextResponse.json(result);
  } catch (error) {
    console.error("cloudflared update failed:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
