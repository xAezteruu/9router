# 9router build — isi & cara pakai

Tar ini berisi **production standalone build** Next.js (v0.5.75 + semua fitur lokal): IP/API-key usage & blocklist, bundled Tor, cloudflared dari npm, Headroom native venv, tunnel token mode, PORT-aware tunnel.

## Ekstrak & jalankan

```bash
mkdir -p ~/9router && tar -xzf 9router-build-2026-09-11.tar.gz -C ~/9router
cd ~/9router
PORT=20128 node custom-server.js
```

Dashboard: http://localhost:20128 — LLM API: http://localhost:20128/v1

## Yang perlu ada di environment

| Var | Wajib? | Catatan |
|---|---|---|
| `PORT` | opsional | default 20127 (custom-server) — set `20128` bila perlu |
| `JWT_SECRET` | disarankan | kunci session dashboard |
| `INITIAL_PASSWORD` | disarankan | default `123456`, wajib ganti sebelum remote access |
| `HEADROOM_URL` | opsional | default `http://localhost:8787` (native mode otomatis pakai ini) |

## Fitur yang self-provision saat pertama dipakai

- **Bundled Tor** — tombol "Add Tor" di Proxy Pools: binary diekstrak ke `$DATA_DIR/bin/tor/`, SOCKS di `127.0.0.1:9051`, pool "Tor (bundled)" dibuat otomatis. Daemon auto-start tiap boot bila pool ada.
- **Cloudflared** — binary dari `node_modules/cloudflared` (sudah termasuk dalam tar); tunnel token / quick URL dari Endpoint settings; updater: `POST /api/tunnel/cloudflared-update`
- **Headroom native** — Start di Endpoint settings: venv dibuat di `$DATA_DIR/headroom/venv`, `headroom-ai[proxy]` ter-install otomatis, proxy jalan di 8787 (butuh Python ≥ 3.10 di host)

## Auto backup database → sql.teru.my.id

`scripts/db-backup.mjs` — upload `data.sqlite` (WAL di-checkpoint dulu) ke server backup:

```bash
# sekali jalan:
node scripts/db-backup.mjs
# daemon tiap 10 menit:
INTERVAL=600000 node scripts/db-backup.mjs
# atau via cron tiap 10 menit:
# */10 * * * * node /path/to/9router/scripts/db-backup.mjs >/dev/null 2>&1
```

Env: `SERVER_URL` (default `https://sql.teru.my.id`), `SOURCE_FILE` (default `$DATA_DIR/db/data.sqlite`), `INTERVAL`, `TIMEOUT`, `RETRIES`.

## IP access log

Setiap hit ke `/v1/*` (sukses maupun ditolak 401/403/404) tercatat otomatis dengan IP + endpoint — lihat di dashboard Usage → IP Access Control, atau `GET /api/usage/ip-access-log`. IP yang diblokir tercatat dengan status `blocked`.

## Catatan

- `DATA_DIR` default `~/.9router` (DB, tor, headroom venv, log — semua di sini)
- Tar berisi `node_modules` production saja; native deps (Tor/Headroom) di-extract on-demand, bukan dalam tar
- Build ini belum termasuk commit git — source masih uncommitted di `/root/9router`
