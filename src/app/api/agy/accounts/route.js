import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { getSettings, updateSettings } from "@/lib/db/repos/settingsRepo.js";

export const dynamic = "force-dynamic";

/**
 * Admin surface for the external agy ACP bridge (provider prefix agy/).
 *
 * The bridge is a separate process (bridge.py) that owns the antigravity
 * account pool; this route is a dashboard-only proxy so account management
 * lives inside 9router without widening the bridge's network exposure.
 * The bridge admin key is stored server-side in settings and never sent
 * to the browser.
 *
 * GET  /api/agy/accounts          -> bridge pool status (+quota per account)
 * POST /api/agy/accounts          -> { action, account?, bridgeUrl?, bridgeKey? }
 *   actions: probe | add | remove | disable | enable | saveConfig | clearConfig
 *
 * Closed to key sessions: account credentials and provider wiring are
 * administrator information.
 */

const DEFAULT_ACTIONS = new Set(["probe", "add", "remove", "disable", "enable"]);

function bridgeConfig(settings) {
  return {
    url: (settings.agyBridgeUrl || "").trim(),
    key: (settings.agyBridgeKey || "").trim(),
  };
}

async function bridgeFetch(path, config, init = {}, timeoutMs = 20000) {
  const base = config.url.replace(/\/+$/, "");
  const headers = { ...(init.headers || {}) };
  if (config.key) headers.Authorization = `Bearer ${config.key}`;
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  return { status: res.status, ok: res.ok, data };
}

export async function GET(request) {
  try {
    const cookieStore = await cookies();
    const session = await getDashboardAuthSession(
      cookieStore.get("auth_token")?.value,
    );
    if (!session || session.role === "apikey") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const settings = await getSettings();
    const config = bridgeConfig(settings);
    if (!config.url) {
      return NextResponse.json({ configured: false, accounts: [] });
    }

    const out = await bridgeFetch("/admin/accounts", config);
    if (!out.ok) {
      return NextResponse.json(
        {
          configured: true,
          reachable: false,
          status: out.status,
          error: out.data?.error?.message || "bridge request failed",
          accounts: [],
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      {
        configured: true,
        reachable: true,
        urlMasked: config.url,
        accounts: (out.data.accounts || []).map((a) => ({
          account: a.account,
          email: a.email,
          disabled: !!a.disabled,
          tokenFile: !!a.tokenFile,
          quota: a.quota || null,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.log("Error listing agy accounts:", error?.message || error);
    return NextResponse.json(
      { error: "Failed to reach agy bridge", reachable: false, accounts: [] },
      { status: 502 },
    );
  }
}

export async function POST(request) {
  try {
    const cookieStore = await cookies();
    const session = await getDashboardAuthSession(
      cookieStore.get("auth_token")?.value,
    );
    if (!session || session.role === "apikey") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const action = String(body.action || "");
    const settings = await getSettings();
    const config = bridgeConfig(settings);

    // saveConfig / clearConfig only touch local settings, no bridge call.
    if (action === "saveConfig") {
      const url = String(body.bridgeUrl || "").trim();
      const key = String(body.bridgeKey || "").trim();
      if (url && !/^https?:\/\//i.test(url)) {
        return NextResponse.json(
          { error: "bridgeUrl must start with http:// or https://" },
          { status: 400 },
        );
      }
      await updateSettings({
        ...(url ? { agyBridgeUrl: url } : {}),
        // empty key means "keep existing"; explicit clearConfig wipes both.
        ...(key ? { agyBridgeKey: key } : {}),
      });
      return NextResponse.json({ ok: true, configured: true });
    }
    if (action === "clearConfig") {
      await updateSettings({ agyBridgeUrl: "", agyBridgeKey: "" });
      return NextResponse.json({ ok: true, configured: false });
    }

    if (!config.url) {
      return NextResponse.json(
        { error: "agy bridge is not configured yet" },
        { status: 400 },
      );
    }
    if (!DEFAULT_ACTIONS.has(action)) {
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }

    const payload = { action };
    if (body.account) payload.account = String(body.account);

    if (action === "probe") {
      const out = await bridgeFetch("/admin/accounts", config);
      return NextResponse.json(
        { ok: out.ok, status: out.status, data: out.ok ? out.data : out.data },
        { status: out.ok ? 200 : out.status === 401 ? 502 : 200 },
      );
    }

    const out = await bridgeFetch("/admin/accounts", config, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return NextResponse.json(
      { ok: out.ok, status: out.status, data: out.data },
      { status: out.ok ? 200 : 200 },
    );
  } catch (error) {
    console.log("Error on agy accounts action:", error?.message || error);
    const msg = /timeout|abort/i.test(String(error?.message || error))
      ? "bridge request timed out"
      : "Failed to reach agy bridge";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
