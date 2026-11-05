// Migration: SQLite data -> MySQL. Run ONCE from repo root with node.
// Usage: node scripts/migrate-sqlite-to-mysql.js [--dry]
// Reads ~/.9router/db/data.sqlite, writes all tables into MySQL (mysql.json cfg).
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";
import mysql from "mysql2/promise";

const DATA_DIR = path.join(os.homedir(), ".9router");
const DB_DIR = path.join(DATA_DIR, "db");
const SQLITE = path.join(DB_DIR, "data.sqlite");
const CFG = JSON.parse(fs.readFileSync(path.join(DB_DIR, "mysql.json"), "utf8"));

const dry = process.argv.includes("--dry");

function loadSqlite() {
  // Copy to temp via sqlite3 .backup to avoid touching the live WAL.
  // NEVER write to the live DB path.
  const tmp = `/tmp/mig-sqlite-${Date.now()}.sqlite`;
  execSync(`sqlite3 "file:${SQLITE}?mode=ro" ".backup '${tmp}'"`);
  return new Database(tmp, { readonly: true, fileMustExist: true });
}
// better-sqlite3 API shim: .all/.get/.run names used below map to .prepare(...).all() etc.
function q(db, sql) { return db.prepare(sql).all(); }

function translateDdl(sql) {
  let s = sql;
  s = s.replace(/\bAUTOINCREMENT\b/gi, "AUTO_INCREMENT");
  s = s.replace(/(?<![`\w])key(?![`\w])/g, "`key`");
  s = s.replace(/(?<![`\w])value(?![`\w])/g, "`value`");
  s = s.replace(/(?<![`\w])usage(?![`\w])/g, "`usage`");
  s = s.replace(/\bTEXT\s+PRIMARY\s+KEY\b/gi, "VARCHAR(191) PRIMARY KEY");
  s = s.replace(/\bTEXT\s+UNIQUE\b/gi, "VARCHAR(191) UNIQUE");
  s = s.replace(/(?<![`\w])key(?![`\w])\s+TEXT\s+NOT\s+NULL/gi, "`key` VARCHAR(191) NOT NULL");
  s = s.replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, "`$1`");
  // TEXT PRIMARY KEY on non-integer ok in MySQL; ensure row format
  if (!/ENGINE=/i.test(s)) s = s.replace(/;$/, " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;");
  return s;
}

async function main() {
  const lite = loadSqlite();
  const conn = await mysql.createConnection({
    host: CFG.host, port: CFG.port || 3306, user: CFG.user, password: CFG.password,
    database: CFG.database, multipleStatements: false,
  });

  // 1. DDL from sqlite_master (tables + indexes), translated
  // Table inventory on MySQL side: if all tables already exist, skip DDL phase entirely
  // (sqlite_master DDL lacks the MySQL dialect translation the adapter does).
  const [mysqlTables] = await conn.query(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()");
  const existing = new Set(mysqlTables.map(r => r.name));
  const allTables = q(lite, `SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL`);
  const ddl = allTables.filter(t => !existing.has(t.name));
  const idx = q(lite, `SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`);
  console.log(`[mig] tables=${ddl.length} indexes=${idx.length}`);
  if (!dry) {
    await conn.query("SET FOREIGN_KEY_CHECKS=0");
    for (const t of ddl) {
      const translated = translateDdl(t.sql);
      try { await conn.query(translated); console.log(`[mig] CREATE ${t.name} OK`); }
      catch (e) { if (/already exists/i.test(e.message)) console.log(`[mig] CREATE ${t.name} exists`); else throw e; }
    }
    // Indexes NOT created here: raw sqlite DDL lacks the TEXT-prefix translation the
    // adapter's syncSchemaFromTables performs on boot (TEXT cols need (191) prefixes,
    // partial WHERE indexes are unsupported). Runtime boot creates all valid indexes.
    await conn.query("SET FOREIGN_KEY_CHECKS=1");
  }

  // 2. Copy rows table by table
  let grand = 0;
  for (const t of allTables) {
    const name = t.name;
    const rows = q(lite, `SELECT * FROM "${name}"`);
    if (!rows.length) { console.log(`[mig] ${name}: 0 rows`); continue; }
    const cols = Object.keys(rows[0]);
    const colSql = cols.map(c => `\`${c}\``).join(",");
    const ph = cols.map(() => "?").join(",");
    let insSql = `INSERT INTO \`${name}\` (${colSql}) VALUES (${ph})`;
    if (!dry && name !== "usageHistory" && name !== "ipAccessLog" && name !== "securityEvents" && name !== "accessEvents") {
      // id-keyed tables: replace on dup (idempotent re-run)
      const upd = cols.filter(c => c !== "id").map(c => `\`${c}\` = VALUES(\`${c}\`)`).join(",");
      if (upd) insSql += ` ON DUPLICATE KEY UPDATE ${upd}`;
    }
    if (dry) { grand += rows.length; console.log(`[mig] ${name}: ${rows.length} rows (dry)`); continue; }
    const BATCH = 200;
    let n = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH).map(r => cols.map(c => {
        const v = r[c];
        return v === undefined ? null : (typeof v === "bigint" ? Number(v) : v);
      }));
      // multi-row insert for speed
      const upd = cols.filter(c => c !== "id").map(c => `\`${c}\` = VALUES(\`${c}\`)`).join(",");
      const multi = `INSERT INTO \`${name}\` (${colSql}) VALUES ${batch.map(() => `(${ph})`).join(",")}`
        + (insSql.includes("ON DUPLICATE KEY UPDATE") ? ` ON DUPLICATE KEY UPDATE ${upd}` : "");
      await conn.query(multi, batch.flat());
      n += batch.length;
    }
    grand += n;
    console.log(`[mig] ${name}: ${n} rows`);
  }
  const [{ c }] = (await conn.query("SELECT COUNT(*) as c FROM providerConnections"))[0];
  console.log(`[mig] DONE total=${grand} providerConnections=${c}${dry ? " (DRY)" : ""}`);
  await conn.end();
  lite.close();
  if (!dry) fs.writeFileSync("/tmp/.mysql-migrated", new Date().toISOString());
}
main().catch(e => { console.error("[mig] FAILED:", e.message); process.exit(1); });
