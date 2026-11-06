// MySQL adapter via worker thread + shared-memory sync bridge.
// Mirrors betterSqliteAdapter contract: run/get/all/exec/transaction are SYNCHRONOUS.
// Enabled by ~/.9router/db/mysql.json {host,port?,user,password,database}.
// Without that file this module is inert — driver.js falls through to SQLite. Rollback = delete file + restart.
//
// Protocol: SAB layout [id:i32][state:i32][len:u32][payload bytes...]
//   main: sets state=1, postMessage({id,op,sql,params}), Atomics.wait(state,1)
//   worker: runs SQL, writes len+payload, stores id, sets state=2|3, notifies
// The worker writes the reply DIRECTLY into shared memory — Atomics.wait blocks the
// main event loop, so main-thread message handlers can never run while waiting.
import { Worker } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { DATA_DIR } from "../../dataDir.js";
import { TABLES } from "../schema.js";
import path from "node:path";

// Config lives next to data.sqlite (DB_DIR) so it ships with the shared bind mount:
const MYSQL_CFG_PATH = path.join(DATA_DIR, "db", "mysql.json");

const WORKER_SRC = `
const { parentPort, workerData } = require("node:worker_threads");
function translate(sql) {
  let s = String(sql);
  // Bare key/value columns are legal in SQLite but reserved-ish in MySQL. Backtick them.
  s = s.replace(/(?<![\u0060\\w])key(?![\u0060\\w])/g, "\u0060key\u0060");
  s = s.replace(/(?<![\u0060\\w])value(?![\u0060\\w])/g, "\u0060value\u0060");
  s = s.replace(/(?<![\u0060\\w])usage(?![\u0060\\w])/g, "\u0060usage\u0060");
  s = s.replace(/\\bON CONFLICT\\s*\\(([^)]*)\\)\\s*DO UPDATE\\s+SET\\b/gi, "ON DUPLICATE KEY UPDATE");
  // SQLite upsert refs excluded.col; MySQL/MariaDB use VALUES(col).
  s = s.replace(/\\bexcluded\\.\\s*\\u0060?([A-Za-z_][A-Za-z0-9_]*)\\u0060?/gi, "VALUES(\\u0060$1\\u0060)");
  // sqlite_master -> information_schema (table inventory queries).
  s = s.replace(/\\bSELECT\\s+name\\s+FROM\\s+sqlite_master\\b([^;]*)/gi,
    (m, rest) => {
      let r = rest.replace(/^\\s*WHERE\\b/i, " AND")
        .replace(/\\btype\\s*=\\s*'table'/i, "table_type = 'BASE TABLE'")
        .replace(/\\blower\\(name\\)/gi, "lower(table_name)")
        .replace(/\\bname\\b/g, "table_name");
      return "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()" + r;
    });
  s = s.replace(/\\bON CONFLICT\\s*\\(([^)]*)\\)\\s*DO NOTHING\\b/gi, "");
  s = s.replace(/INSERT\\s+OR\\s+IGNORE\\b/gi, "INSERT IGNORE");
  s = s.replace(/INSERT\\s+OR\\s+REPLACE\\b/gi, "REPLACE");
  // PRAGMA table_info(t) -> information_schema.columns (rows carry .name for syncSchemaFromTables).
  s = s.replace(/\\bPRAGMA\\s+table_info\\(\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\)/gi,
    (m, t) => "SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = '" + t + "'");
  s = s.replace(/\\bAUTOINCREMENT\\b/gi, "AUTO_INCREMENT");
  s = s.replace(/date\\('now'\\)/gi, "CURDATE()");
  s = s.replace(/datetime\\('now'\\)/gi, "UTC_TIMESTAMP()");
  s = s.replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, '\u0060$1\u0060');
  // MySQL refuses TEXT keys without a length. Every TEXT key col in 9router holds a
  // uuid/short id/timestamp/scope key -> VARCHAR(191) is safe for utf8mb4 indexes.
  s = s.replace(/\\b(TEXT|VARCHAR)\\s+PRIMARY\\s+KEY\\b/gi, "VARCHAR(191) PRIMARY KEY");
  s = s.replace(/\\bTEXT\\s+UNIQUE\\b/gi, "VARCHAR(191) UNIQUE");
  s = s.replace(/\\bPRIMARY\\s+KEY\\s*\\(\\s*([^)]*\\bTEXT\\b[^)]*)\\s*\\)/gi, (m, inner) => {
    if (/VARCHAR|CHAR/i.test(inner)) return m;
    const cols = inner.split(",").map(c => c.trim().replace(/^(\\w+)\\s+TEXT$/i, "$1"));
    return "PRIMARY KEY (" + cols.join(", ") + ")";
  });
  // Composite PK over TEXT columns: retype the referenced column defs to VARCHAR(191)
  // (kv table: scope TEXT NOT NULL, key TEXT NOT NULL + PRIMARY KEY (scope, key)).
  s = s.replace(/(scope|key|dateKey|day|month)\\s+TEXT\\s+NOT\\s+NULL/gi, "$1 VARCHAR(191) NOT NULL");
  s = s.replace(/\\u0060(scope|key|dateKey|day|month)\\u0060\\s+TEXT\\s+NOT\\s+NULL/gi, "\\u0060$1\\u0060 VARCHAR(191) NOT NULL");
  // MariaDB rejects LIMIT inside IN/NOT IN subqueries ("LIMIT & IN/ALL/ANY/SOME
  // subquery"). Wrap the subquery as a derived table: IN (SELECT ...) ->
  // IN (SELECT * FROM (SELECT ...) AS sub).
  s = s.replace(/(IN\\s*\\()(\\s*SELECT\\s[\\s\\S]*?\\bLIMIT\\s[\\s\\S]*?\\))/gi,
    (m, head, sub) => (sub.includes("FROM (") ? m
      : head + "SELECT * FROM (" + sub.trim().replace(/\\s+/g, " ").replace(/\\s*\\)/g, ")") + " AS __limsub__)"));
  // SQLite partial indexes (CREATE INDEX ... WHERE <pred>) have no MySQL form.
  // A unique index on a nullable column already permits duplicate NULLs, so the
  // WHERE predicate (dedupeKey IS NOT NULL) is safe to drop entirely.
  s = s.replace(/(CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?[\\u0060A-Za-z_][\\u0060A-Za-z0-9_]*\\s+ON\\s+[\\u0060A-Za-z_][\\u0060A-Za-z0-9_]*\\s*\\([^)]*\\))\\s+WHERE\\s+.+$/gis, "$1");
  // Indexes over TEXT columns need prefix lengths in MySQL: CREATE INDEX ... ON t(col)
  // -> t(col(191)). Applies to single/composite index column lists on TEXT-typed cols.
  s = s.replace(/ON\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*\\(([^)]+)\\)/gi, (m, tbl, cols) => {
    if (/^conflict$|^duplicate$|^key$/i.test(tbl)) return m;
    // Prefix only TEXT-typed columns (int cols reject prefixes). textCols map passed
    // via workerData (TABLES not importable inside worker source).
    const tblDef = workerData.textColsByTable ? workerData.textColsByTable[tbl] : null;
    const textCols = tblDef || null;
    const fixed = cols.split(",").map(c => {
      const trimmed = c.trim();
      if (textCols && !textCols.includes(trimmed.replace(/[\u0060\\s]+/g, ""))) return trimmed;
      return trimmed.replace(/^([\u0060]?[A-Za-z_][A-Za-z0-9_]*[\u0060]?)$/, "$1(191)");
    }).join(", ");
    return "ON " + tbl + " (" + fixed + ")";
  });
  return s;
}
(async () => {
  const mysql = require("mysql2/promise");
  const cfg = workerData.cfg;
  const sab = workerData.sab;
  const sync = new Int32Array(sab, 0, 2);
  const lenField = new Uint32Array(sab, 8, 1);
  const payload = Buffer.from(sab, 12);

  const reply = (id, ok, data) => {
    const buf = Buffer.from(data, "utf8");
    if (buf.length > payload.length) throw new Error("reply too large: " + buf.length);
    lenField[0] = buf.length;
    buf.copy(payload, 0);
    Atomics.store(sync, 0, id);
    Atomics.store(sync, 1, ok ? 2 : 3);
    Atomics.notify(sync, 1);
  };

  let conn = await mysql.createConnection({
    host: cfg.host, port: cfg.port || 3306, user: cfg.user, password: cfg.password,
    database: cfg.database, connectTimeout: 10000,
    namedPlaceholders: false, multipleStatements: false, enableKeepAlive: true, keepAliveInitialDelay: 10000,
  });
  // Long-lived sync bridge: single connection must survive idle periods and
  // server restarts. mysql2 surfaces a dead connection as "Can't add new
  // command when connection is in closed state" — recreate and retry once.
  const queryOnce = async (sql, params) => {
    try {
      return await conn.query(sql, params);
    } catch (e) {
      if (!/closed state|ECONNRESET|PROTOCOL_CONNECTION_LOST|ETIMEDOUT|EPIPE/i.test(String(e.message) + " " + String(e.code))) throw e;
      const fresh = await mysql.createConnection({
        host: cfg.host, port: cfg.port || 3306, user: cfg.user, password: cfg.password,
        database: cfg.database, connectTimeout: 10000,
        namedPlaceholders: false, multipleStatements: false, enableKeepAlive: true, keepAliveInitialDelay: 10000,
      });
      try { conn.end().catch(() => {}); } catch {}
      conn = fresh;
      return await conn.query(sql, params);
    }
  };
  parentPort.postMessage({ type: "ready" });
  parentPort.on("message", async (msg) => {
    const { id, op, sql, params } = msg;
    try {
      const t = translate(sql);
      if (op === "exec") {
        const stmts = t.split(/;\\s*\\n|;/).map(s => s.trim()).filter(Boolean);
        for (const s of stmts) {
          if (/^\\s*PRAGMA\\b/i.test(s)) continue;
          await queryOnce(s);
        }
        reply(id, true, "{}");
        return;
      }
      const [result] = await queryOnce(t, params || []);
      if (op === "run") {
        reply(id, true, JSON.stringify({ changes: result.affectedRows ?? 0, insertId: Number(result.insertId ?? 0) }));
      } else {
        reply(id, true, JSON.stringify(result));
      }
    } catch (e) {
      try { reply(id, false, JSON.stringify({ err: e.message, code: e.code })); }
      catch (e2) { Atomics.store(sync, 1, 3); Atomics.notify(sync, 1); }
    }
  });
})().catch((e) => parentPort.postMessage({ type: "fatal", error: e.message }));
`;

// 128MB reply ceiling: usageHistory dumps / requestDetails rows are the big ones.
const MAX_PAYLOAD = 128 * 1024 * 1024;
const HEADER = 12; // id + state + len

function createMysqlAdapter(cfg) {
  // TEXT-typed columns per table (for index prefix length decisions in worker translate).
  const textColsByTable = {};
  for (const [name, def] of Object.entries(TABLES)) {
    const cols = [];
    for (const [cn, ct] of Object.entries(def.columns || {})) {
      if (/^TEXT/i.test(String(ct))) cols.push(cn);
    }
    if (cols.length) textColsByTable[name] = cols;
  }
  const sab = new SharedArrayBuffer(HEADER + MAX_PAYLOAD);
  const sync = new Int32Array(sab, 0, 2); // [0]=id echo, [1]=state
  const lenField = new Uint32Array(sab, 8, 1);
  const payload = Buffer.from(sab, HEADER, MAX_PAYLOAD);

  let workerFatal = null;
  const markFatal = (e) => {
    workerFatal = e || new Error("[DB] mysql worker failed");
    try { Atomics.store(sync, 1, 3); Atomics.notify(sync, 1); } catch {}
  };

  const worker = new Worker(WORKER_SRC, { eval: true, workerData: { cfg, sab, textColsByTable } });
  worker.on("message", (m) => { if (m.type === "fatal") markFatal(new Error(`[DB] mysql worker fatal: ${m.error}`)); });
  worker.on("error", (e) => markFatal(e));
  worker.on("exit", (code) => { if (code !== 0) markFatal(new Error(`[DB] mysql worker exited code ${code}`)); });

  // Connection handshake happens once, at init — getAdapter awaits this factory.
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("[DB] mysql connect timeout (15s)")), 15000);
    worker.once("message", (m) => {
      if (m.type === "ready") { clearTimeout(t); resolve(); }
      else if (m.type === "fatal") { clearTimeout(t); reject(new Error(`[DB] mysql: ${m.error}`)); }
    });
  });

  let nextId = 1;

  function callSync(op, sql, params) {
    if (workerFatal) throw workerFatal;
    const id = nextId++;
    Atomics.store(sync, 0, 0);
    Atomics.store(sync, 1, 1);
    worker.postMessage({ id, op, sql, params });
    const w = Atomics.wait(sync, 1, 1, 120000);
    if (workerFatal && Atomics.load(sync, 1) !== 2) throw workerFatal;
    if (w === "timed-out") throw new Error(`[DB] mysql timeout: ${op} ${String(sql).slice(0, 100)}`);
    const st = Atomics.load(sync, 1);
    const len = lenField[0];
    const str = len > 0 ? Buffer.from(payload.subarray(0, len)).toString("utf8") : "{}";
    if (st === 3) {
      let emsg = "unknown error";
      try { const p = JSON.parse(str); emsg = p.err || emsg; } catch {}
      throw new Error(`[DB] mysql ${op} failed: ${emsg}`);
    }
    const p = JSON.parse(str);
    if (op === "run") return { changes: p.changes ?? 0, lastInsertRowid: p.insertId ?? 0 };
    return p;
  }

  return {
    driver: "mysql",
    ready,
    run(sql, params = []) { return callSync("run", sql, params); },
    get(sql, params = []) {
      const rows = callSync("all", sql, params);
      return rows[0];
    },
    all(sql, params = []) { return callSync("all", sql, params); },
    exec(sql) { return callSync("exec", sql, []); },
    transaction(fn) {
      callSync("exec", "START TRANSACTION", []);
      try {
        const r = fn();
        callSync("exec", "COMMIT", []);
        return r;
      } catch (e) {
        try { callSync("exec", "ROLLBACK", []); } catch {}
        throw e;
      }
    },
    checkpoint() {},
    close() { try { worker.terminate(); } catch {} },
    raw: null,
  };
}

export async function createMysqlAdapterIfNeeded() {
  const cfgPath = MYSQL_CFG_PATH;
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  } catch {
    return null; // no/unreadable config -> SQLite path (normal)
  }
  const adapter = createMysqlAdapter(cfg);
  await adapter.ready;
  return adapter;
}
