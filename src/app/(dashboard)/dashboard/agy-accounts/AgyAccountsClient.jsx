"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Manage antigravity accounts on the external agy ACP bridge (prefix agy/).
 * Talks to /api/agy/accounts (dashboard-only proxy); the bridge key stays
 * server-side in settings and is never shipped to the browser.
 */

function quotaLines(quota) {
  if (!quota) return [];
  if (quota.error) return [`${quota.error}`];
  const lines = [];
  for (const [group, buckets] of Object.entries(quota.groups || quota)) {
    if (!buckets || typeof buckets !== "object") continue;
    for (const [bucket, info] of Object.entries(buckets)) {
      if (info && typeof info === "object" && "fraction" in info) {
        const pct = Math.round((info.fraction || 0) * 100);
        lines.push(`${group} [${bucket}]: ${pct}%`);
      }
    }
  }
  return lines;
}

export default function AgyAccountsClient() {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState(null);
  const [cfgUrl, setCfgUrl] = useState("");
  const [cfgKey, setCfgKey] = useState("");
  const [newAccount, setNewAccount] = useState("");

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const res = await fetch("/api/agy/accounts", { cache: "no-store" });
      const data = await res.json();
      setState({ loading: false, data, error: data.error || null });
    } catch (e) {
      setState({ loading: false, data: null, error: String(e) });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (payload, label) => {
    setBusy(label);
    setNotice(null);
    try {
      const res = await fetch("/api/agy/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setNotice({ kind: "err", text: data.error || `HTTP ${res.status}` });
      } else if (payload.action === "saveConfig") {
        setNotice({ kind: "ok", text: "Bridge config saved." });
        setCfgKey("");
        await load();
      } else if (payload.action === "clearConfig") {
        setNotice({ kind: "ok", text: "Bridge config cleared." });
        await load();
      } else {
        setNotice({ kind: "ok", text: `${label}: ok` });
        await load();
      }
    } catch (e) {
      setNotice({ kind: "err", text: String(e) });
    } finally {
      setBusy("");
    }
  };

  const d = state.data;
  const accounts = d?.accounts || [];

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">AGY Bridge Accounts</h1>
        <button
          className="px-3 py-1.5 rounded border text-sm disabled:opacity-50"
          onClick={load}
          disabled={state.loading}
        >
          {state.loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <p className="text-sm opacity-70">
        Antigravity accounts served by the external ACP bridge (models prefixed
        <code className="mx-1 px-1 rounded bg-black/20">agy/</code>). The bridge
        rotates accounts and skips exhausted quota buckets automatically.
      </p>

      {notice && (
        <div
          className={`text-sm px-3 py-2 rounded border ${
            notice.kind === "err"
              ? "border-red-500/50 text-red-400 bg-red-500/10"
              : "border-emerald-500/50 text-emerald-400 bg-emerald-500/10"
          }`}
        >
          {notice.text}
        </div>
      )}

      {!d && state.loading && <p className="text-sm opacity-60">Loading…</p>}

      {d && !d.configured && (
        <div className="rounded border p-4 space-y-3">
          <p className="text-sm">
            Bridge belum dikonfigurasi. Isi URL bridge dan admin key-nya.
          </p>
          <input
            className="w-full px-3 py-2 rounded border bg-black/20 text-sm"
            placeholder="http://127.0.0.1:8317"
            value={cfgUrl}
            onChange={(e) => setCfgUrl(e.target.value)}
          />
          <input
            className="w-full px-3 py-2 rounded border bg-black/20 text-sm"
            type="password"
            placeholder="bridge api key (admin)"
            value={cfgKey}
            onChange={(e) => setCfgKey(e.target.value)}
          />
          <button
            className="px-3 py-1.5 rounded border text-sm disabled:opacity-50"
            disabled={busy === "save" || !cfgUrl}
            onClick={() =>
              act(
                { action: "saveConfig", bridgeUrl: cfgUrl, bridgeKey: cfgKey },
                "save",
              )
            }
          >
            Save config
          </button>
        </div>
      )}

      {d?.configured && (
        <>
          {!d.reachable && (
            <div className="text-sm px-3 py-2 rounded border border-red-500/50 text-red-400 bg-red-500/10">
              Bridge tidak reachable ({d.status || "?"}):{" "}
              {d.error || "unknown error"}
            </div>
          )}

          <div className="rounded border divide-y">
            {accounts.map((a) => {
              const q = quotaLines(a.quota);
              return (
                <div
                  key={a.account}
                  className="p-3 flex items-center justify-between gap-3 flex-wrap"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-sm">
                      {a.email}{" "}
                      <span className="opacity-50">({a.account})</span>
                      {a.disabled && (
                        <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400">
                          disabled
                        </span>
                      )}
                      {!a.tokenFile && (
                        <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">
                          no token file
                        </span>
                      )}
                    </div>
                    {q.length > 0 && (
                      <div className="text-xs opacity-70 mt-1">
                        {q.join(" · ")}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button
                      className="px-2.5 py-1 rounded border text-xs disabled:opacity-50"
                      disabled={busy === a.account}
                      onClick={() =>
                        act(
                          {
                            action: a.disabled ? "enable" : "disable",
                            account: a.account,
                          },
                          a.account,
                        )
                      }
                    >
                      {a.disabled ? "Enable" : "Disable"}
                    </button>
                    <button
                      className="px-2.5 py-1 rounded border text-xs text-red-400 disabled:opacity-50"
                      disabled={busy === a.account || accounts.length <= 1}
                      onClick={() =>
                        act(
                          { action: "remove", account: a.account },
                          a.account,
                        )
                      }
                    >
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}
            {accounts.length === 0 && d.reachable && (
              <div className="p-3 text-sm opacity-60">
                Tidak ada akun terdaftar di bridge.
              </div>
            )}
          </div>

          <div className="rounded border p-4 space-y-3">
            <p className="text-sm font-medium">Tambah akun</p>
            <p className="text-xs opacity-60">
              Token file harus sudah ada di host bridge:
              <code className="ml-1 px-1 rounded bg-black/20">
                $AGY_HOME/&lt;nama&gt;/.gemini/&lt;nama&gt;/appdata/antigravity-oauth-token
              </code>
              (login dulu di host, atau salin token OAuth ke path itu).
            </p>
            <div className="flex gap-2">
              <input
                className="flex-1 px-3 py-2 rounded border bg-black/20 text-sm"
                placeholder="acct3"
                value={newAccount}
                onChange={(e) => setNewAccount(e.target.value)}
              />
              <button
                className="px-3 py-1.5 rounded border text-sm disabled:opacity-50"
                disabled={busy === "add" || !newAccount.trim()}
                onClick={() =>
                  act(
                    { action: "add", account: newAccount.trim() },
                    "add",
                  ).then(() => setNewAccount(""))
                }
              >
                Add
              </button>
            </div>
          </div>

          <div className="rounded border p-4 space-y-3">
            <p className="text-sm font-medium">Bridge config</p>
            <p className="text-xs opacity-60">
              URL saat ini: <code>{d.urlMasked || "tersembunyi"}</code> — key
              disimpan server-side dan tidak pernah dikirim ke browser.
            </p>
            <input
              className="w-full px-3 py-2 rounded border bg-black/20 text-sm"
              placeholder="URL bridge baru (opsional)"
              value={cfgUrl}
              onChange={(e) => setCfgUrl(e.target.value)}
            />
            <input
              className="w-full px-3 py-2 rounded border bg-black/20 text-sm"
              type="password"
              placeholder="key baru (opsional, kosongkan biar tetap)"
              value={cfgKey}
              onChange={(e) => setCfgKey(e.target.value)}
            />
            <div className="flex gap-2">
              <button
                className="px-3 py-1.5 rounded border text-sm disabled:opacity-50"
                disabled={busy === "save" || (!cfgUrl && !cfgKey)}
                onClick={() =>
                  act(
                    { action: "saveConfig", bridgeUrl: cfgUrl, bridgeKey: cfgKey },
                    "save",
                  )
                }
              >
                Update config
              </button>
              <button
                className="px-3 py-1.5 rounded border text-sm text-red-400 disabled:opacity-50"
                disabled={busy === "clear"}
                onClick={() => act({ action: "clearConfig" }, "clear")}
              >
                Clear config
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
