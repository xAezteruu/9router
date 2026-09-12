import { NextResponse } from "next/server";
import { getIpAccessLog } from "@/lib/usageDb";
import { getSettings, updateSettings } from "@/lib/localDb";

export const dynamic = "force-dynamic";

/**
 * GET /api/usage/ip-access-log
 * Distinct client IPs seen on the LLM API (total requests + last seen) + current blocklist.
 */
export async function GET() {
  try {
    const [ips, settings] = await Promise.all([getIpAccessLog(), getSettings()]);
    return NextResponse.json({ ips, blockedIps: settings.blockedIps || [] });
  } catch (error) {
    console.log("Error getting IP access log:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * PATCH /api/usage/ip-access-log
 * Body: { ip: string, blocked: boolean } → add/remove from settings.blockedIps
 */
export async function PATCH(request) {
  try {
    const body = await request.json();
    const ip = typeof body.ip === "string" ? body.ip.trim() : "";
    if (!ip) {
      return NextResponse.json({ error: "ip is required" }, { status: 400 });
    }
    const blocked = body.blocked === true;
    const settings = await getSettings();
    const current = settings.blockedIps || [];
    const next = blocked
      ? (current.includes(ip) ? current : [...current, ip])
      : current.filter((v) => v !== ip);
    const updated = await updateSettings({ blockedIps: next });
    return NextResponse.json({ blockedIps: updated.blockedIps || [] });
  } catch (error) {
    console.log("Error updating IP blocklist:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
