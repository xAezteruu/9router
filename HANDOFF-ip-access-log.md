# HANDOFF — Fitur: IP + API Key di Usage Details & Block/Unblock IP

Diparkir 2026-09-10 (pindah machine). Riset selesai, implementasi belum dimulai.

## Request user (asli)
1. Di page `/usage`, bagian details: tampilkan **IP** dan **API key** yang mengakses.
2. Di settings: simpan **daftar IP unik** yang pernah request ke 9router → bisa **block/unblock**.
3. Bonus: total jumlah request per IP.

## Temuan arsitektur (berlaku saat ditulis)

### Storage request details
- Tabel `requestDetails`: id, timestamp, provider, model, connectionId, status, **data (JSON blob)**.
- `src/lib/db/repos/requestDetailsRepo.js`: `saveRequestDetail(detail)` → buffer → `flushToDatabase()` → INSERT pakai `stringifyJson(record)`.
- `getRequestDetails(filter)` → parse blob.
- **Kesimpulan: tambah field `ip`/`apiKey` cukup di objek detail — TIDAK perlu migration DB / bump SCHEMA_VERSION.**

### Alur request
```
src/app/api/v1/chat/completions/route.js (POST → handleChat)
  → src/sse/handlers/chat.js  handleChat(request, clientRawRequest)
      - apiKey = extractApiKey(request)   (Bearer | x-api-key)  [sudah ada]
      - build clientRawRequest {endpoint, body, headers}
      - handleChatCore({... apiKey, clientRawRequest, ...})
  → open-sse/handlers/chatCore.js  handleChatCore(ctx)
      - sharedCtx = { provider, model, body, stream, translatedBody, finalBody,
                      requestStartTime, connectionId, apiKey, clientRawRequest,
                      onRequestSuccess, pxpipe, reqTag, log }
      - dispatch ke streamingHandler / nonStreamingHandler / sseToJsonHandler (forced SSE→JSON)
  → saveRequestDetail(buildRequestDetail({...}))
```

### Call-site saveRequestDetail (semua di open-sse/handlers/chatCore/)
| Tempat | Baris | Path |
|---|---|---|
| executor throw | chatCore.js ~379 | open-sse/handlers/chatCore.js |
| provider error | chatCore.js ~453 | open-sse/handlers/chatCore.js |
| stream error | ~90, ~124 | open-sse/handlers/chatCore/streamingHandler.js |
| non-streaming done | ~374 | open-sse/handlers/chatCore/nonStreamingHandler.js |
| forced SSE→JSON | ~218, ~311 | open-sse/handlers/chatCore/sseToJsonHandler.js |

- `buildRequestDetail(base, overrides)` di `open-sse/handlers/chatCore/requestDetail.js` — spread `...overrides`, base fields.
- Semua call-site sudah punya `apiKey` (via ctx destructure). IP belum ada di scope → **cara terbersih: hitung `ip` sekali di `handleChat` (src/sse/handlers/chat.js), kirim via ctx `handleChatCore`, tambah ke `sharedCtx`, teruskan ke semua handler, terus ke `buildRequestDetail`** → otomatis masuk semua path (sukses + error).

### IP yang dipercaya
- `custom-server.js` stamp `x-9r-real-ip` (dari TCP socket, unspoofable) + `x-9r-peer-token` (secret per proses) + set `NINEROUTER_PEER_TOKEN` env.
- `src/lib/auth/trustedPeer.js`: `hasTrustedPeerHeaders(request)` — cek `x-9r-peer-token === NINEROUTER_PEER_TOKEN`.
- Pola paten: `getClientIp` di `src/lib/auth/loginLimiter.js`:
  1. trusted peer → `x-9r-real-ip`
  2. `TRUST_PROXY === "true"` → XFF pertama
  3. else `"unknown"` (single bucket, anti-spoof XFF)
- `handleChat` punya `request` (NextRequest) → `request.headers.get("x-9r-real-ip")` dengan guard `hasTrustedPeerHeaders`.

### Settings
- `src/lib/db/repos/settingsRepo.js` → `DEFAULT_SETTINGS` (tambah default `blockedIps: []` di sini).
- API: `GET|PATCH /api/settings` (`src/app/api/settings/route.js`) → `updateSettings(body)` mass-assign; `PROTECTED_SETTING_KEYS = ["password", "mitmSudoEncrypted"]`.
- UI settings: `src/app/(dashboard)/dashboard/profile/page.js` — section **Observability ~baris 1601-1621** (Toggle enableObservability), pola handler `updateObservabilityEnabled`, fetch `/api/settings` PATCH. Sidebar nav cosntant di `src/shared/components/Sidebar.js`.

### Enforcement blokir (belum dipilih final, rekomendasi)
- **Paling kuat: `src/dashboardGuard.js` `proxy()`** (dipasang via `src/proxy.js`, berjalan sebelum rewrite Next /v1/*). Sudah ada `loadSettings()` di sana. Cek `hasTrustedPeerHeaders` + `x-9r-real-ip` ∈ `settings.blockedIps` → return 403. Ini middleware seluruh app.
- Alternatif lemah: cek di dalam `handleChat` (chat.js) — hanya cover /chat, tidak cover embeddings/search/fetch dll.
- Catatan: kalau blokir di dashboardGuard, jangan lupa `/responses`, `/codex`, `/v1beta` ikut ke-PUBLIC_PREFIXES (sudah lewat proxy yang sama).

### API keys
- `extractApiKey(request)` di `src/sse/services/auth.js` (Bearer → x-api-key).
- `validateApiKey` di `@/lib/localDb` (dipakai dashboardGuard juga).
- Display masked pakai pola `maskKey`: `first4...last4` (src/sse/utils/logger.js:114).
- Simpan key mentah di detail (history request sudah rahasia; request.headers di-sanitize cuma buang authorization header, value key nggak). UI tampil masked.

### Hash access per IP (untuk "total request" & list IP unik)
- `getDistinctProviders` adalah pola query DISTINCT yang sama → tambah helper query `SELECT data FROM requestDetails` lalu akumulasi per-IP, atau query langsung apiUsage. `usageHistory` juga ada (usage logs) tapi tanpa ip per-request → lebih mudah dari requestDetails bila observability enabled.
- Catatan: requestDetails hanya terisi bila `enableObservability` (settingsRepo default `false`) — fitur IP access log bergantung pada toggle ini. Kalau mau selalu, raise di decision.

## Keputusan yang belum diambil user
1. Tampilkan IP/apiKey di **table** usage atau hanya **drawer detail**? (Rekomendasi: kolom IP di table + masked key di drawer.)
2. Section block/unblock: di profile settings atau halaman baru? (Rekomendasi: section baru di profile settings, dan/atau tab di /usage.)
3. Blocking berlaku untuk dashboard juga atau hanya /v1 API? (Rekomendasi: only /v1 LLM API — jangan blokir dashboard sendiri.)
4. Apakah IP access log harus jalan walau observability off? (Rekomendasi: track selalu ke usage logging, detail tetap perlu observability.)

## File yang disentuh nanti (rencana)
- `src/sse/handlers/chat.js` — hitung ip, kirim ke handleChatCore.
- `open-sse/handlers/chatCore.js` — sharedCtx + ip.
- `open-sse/handlers/chatCore/{streamingHandler,nonStreamingHandler,sseToJsonHandler}.js` — teruskan ip ke buildRequestDetail.
- `open-sse/handlers/chatCore/requestDetail.js` — buildRequestDetail: tambah `ip`, `apiKey` field.
- (opsional repo) `src/lib/db/repos/requestDetailsRepo.js` — filter by ip kalau mau.
- `src/lib/db/repos/settingsRepo.js` — `blockedIps: []` default.
- `src/dashboardGuard.js` — enforce blocklist (x-9r-real-ip).
- `src/app/(dashboard)/dashboard/usage/components/RequestDetailsTab.js` — kolom IP, tampil masked key, total request.
- `src/app/(dashboard)/dashboard/profile/page.js` — UI block/unblock + list IP unik.
- `src/app/api/usage/...` — endpoint baru list IP + block/unblock (atau via /api/settings).

## Context ekstra
- Repo: 9Router (9router-app), root package "9router-app", Next.js standalone + custom-server.js wrapper.
- Tests: vitest di tests/ (independent package, ~938 pass / ~64 fail baseline — jangan judge raw). Regression verify: `tests/__baseline__/verify-no-regression.mjs`.
- DB: src/lib/db (bun:sqlite → better-sqlite3 → node:sqlite → sql.js), file `~/.9router/db/data.sqlite`, usage logs `~/.9router/usage.json` + log.txt (tidak ikut DATA_DIR).
- Conventions: ESM, `@/*` → src/*, plain JS no TS. JANGAN hand-edit `src/lib/providers/registry/index.js` (auto-generated).
- Security: JWT_SECRET, INITIAL_PASSWORD default 123456, API_KEY_SECRET, MACHINE_ID_SALT.