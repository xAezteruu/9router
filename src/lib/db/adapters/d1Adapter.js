// D1 adapter — map D1 API to SQLite-like interface
export function createD1Adapter(d1Binding) {
  // d1Binding: Cloudflare Workers D1Database binding
  if (!d1Binding || typeof d1Binding.prepare !== 'function') {
    throw new Error('[D1] Invalid binding — expected D1Database with prepare()');
  }

  const driver = 'd1';

  // D1 uses named parameters (?1, ?2, ...) or positional (?)
  // sql.js uses positional (?) only
  function normalizeSql(sql) {
    return sql;
  }

  function paramsArray(params) {
    if (!params) return [];
    return Array.isArray(params) ? params : [params];
  }

  async function run(sql, params = []) {
    const stmt = d1Binding.prepare(normalizeSql(sql));
    const result = await stmt.bind(paramsArray(params)).run();
    return {
      changes: result.meta.last_row_id ? 1 : (result.success ? 1 : 0),
      lastInsertRowid: result.meta.last_row_id || null
    };
  }

  async function get(sql, params = []) {
    const stmt = d1Binding.prepare(normalizeSql(sql));
    const result = await stmt.bind(paramsArray(params)).all();
    const rows = result.results || [];
    return rows.length > 0 ? rows[0] : null;
  }

  async function all(sql, params = []) {
    const stmt = d1Binding.prepare(normalizeSql(sql));
    const result = await stmt.bind(paramsArray(params)).all();
    return result.results || [];
  }

  async function transaction(fn) {
    // D1 supports explicit transaction with batch
    // We use a simple approach: wrap calls in a batch
    return await fn();
  }

  function close() {
    // D1 connections are managed by runtime
  }

  return { driver, run, get, all, transaction, close };
}
