#!/usr/bin/env node
/**
 * Auto SQLite backup → sql.teru.my.id
 *
 * Dibundle bareng 9router: sebelum upload, data.sqlite di-checkpoint dulu
 * (WAL merged ke main file) supaya yang terkirim adalah snapshot utuh
 * terbaru. Jalankan dari root standalone build:  node scripts/db-backup.mjs
 *
 * Env:
 *   SERVER_URL    URL server upload   (default https://sql.teru.my.id)
 *   SOURCE_FILE   file SQLite         (default $DATA_DIR/db/data.sqlite)
 *   INTERVAL      ms antar kirim      (default 0 = sekali jalan)
 *   TIMEOUT       timeout HTTP ms     (default 60000)
 *   RETRIES       jumlah retry        (default 2)
 */
'use strict';

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const SERVER_URL = String(process.env.SERVER_URL || 'https://sql.teru.my.id').replace(/\/+$/, '');
const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), '.9router');
const SOURCE_FILE = path.resolve(process.env.SOURCE_FILE || path.join(DATA_DIR, 'db', 'data.sqlite'));
const INTERVAL = Math.max(0, Number(process.env.INTERVAL || 0));
const TIMEOUT = Math.max(1000, Number(process.env.TIMEOUT || 60000));
const RETRIES = Math.max(0, Number(process.env.RETRIES || 2));

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0');

function isSqlite(data) {
  return data.length >= 32 && data.subarray(0, 16).equals(SQLITE_MAGIC);
}

// Checkpoint WAL → semua transaksi yang masih di -wal file digabung ke
// data.sqlite utama. Tanpa ini, file yang di-upload bisa janggal beberapa
// transaksi terakhir. Pakai node:sqlite bila ada, fallback ke sqlite3 CLI.
function checkpointWal(dbFile) {
  try {
    // Node 22.5+ punya node:sqlite bawaan
    return import('node:sqlite').then(({ DatabaseSync }) => {
      const db = new DatabaseSync(dbFile);
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      db.close();
      return 'node:sqlite';
    }).catch(() => checkpointWalCli(dbFile));
  } catch {
    return Promise.resolve(checkpointWalCli(dbFile));
  }
}

function checkpointWalCli(dbFile) {
  try {
    execFileSync('sqlite3', [dbFile, 'PRAGMA wal_checkpoint(TRUNCATE);'], { stdio: 'pipe', timeout: 10_000 });
    return 'sqlite3-cli';
  } catch (e2) {
    // Boleh lanjut tanpa checkpoint — tapi idealnya tercapai.
    console.warn(`[backup] checkpoint skipped (${e2.message?.slice(0, 80)})`);
    return null;
  }
}

async function uploadOnce() {
  await checkpointWal(SOURCE_FILE);
  const data = fs.readFileSync(SOURCE_FILE);
  if (!isSqlite(data)) {
    return Promise.reject(new Error(`Bukan file SQLite: ${SOURCE_FILE} (magic header tidak cocok)`));
  }
  return new Promise((resolve, reject) => {
    const u = new URL(SERVER_URL + '/upload');
    const transport = u.protocol === 'https:' ? https : (u.protocol === 'http:' ? http : null);
    if (!transport) return reject(new Error(`Protokol tidak didukung: "${u.protocol}"`));
    const started = Date.now();
    const req = transport.request(
      u,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-sqlite3', 'Content-Length': data.length },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = JSON.parse(body); } catch {}
          if (res.statusCode !== 201) {
            const msg = parsed && parsed.error ? parsed.error : body || `HTTP ${res.statusCode}`;
            const err = new Error(`Upload ditolak (${res.statusCode}): ${msg}`);
            err.statusCode = res.statusCode;
            return reject(err);
          }
          resolve({ parsed, ms: Date.now() - started, size: data.length });
        });
      },
    );
    req.setTimeout(TIMEOUT, () => req.destroy(new Error(`Timeout ${TIMEOUT} ms`)));
    req.on('error', reject);
    req.end(data);
  });
}

async function run() {
  for (let i = 0; i <= RETRIES; i++) {
    try {
      const { parsed, ms, size } = await uploadOnce();
      const f = parsed || {};
      const kept = Array.isArray(f.kept) ? f.kept.length : 0;
      const removed = Array.isArray(f.removed) ? f.removed.length : 0;
      console.log(`[${new Date().toISOString()}] OK ${f.name} (${size} bytes) kept=${kept} deleted=${removed} dalam ${ms} ms`);
      return;
    } catch (e) {
      const isLast = i === RETRIES;
      console.error(`[${new Date().toISOString()}] Gagal (${i + 1}/${RETRIES + 1}): ${e.message}`);
      if (isLast) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

if (INTERVAL > 0) {
  console.log(`[backup] daemon aktif: kirim tiap ${INTERVAL} ms -> ${SERVER_URL} (${SOURCE_FILE})`);
  run().catch((e) => console.error(`[${new Date().toISOString()}] ${e.message}`));
  setInterval(() => {
    run().catch((e) => console.error(`[${new Date().toISOString()}] ${e.message}`));
  }, INTERVAL);
} else {
  run().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
