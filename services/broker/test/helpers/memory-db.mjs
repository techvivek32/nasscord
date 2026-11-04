import { randomUUID } from "node:crypto";

/**
 * In-memory stand-in for the PostgREST Db interface in src/db.mjs (select, insert, update, upsert,
 * remove), with the table defaults, unique keys and cascades of the init migration that the
 * service relies on.
 */

/** @param {() => number} now */
function defaults(now) {
  const ts = () => new Date(now()).toISOString();
  /** @type {Record<string, () => Record<string, unknown>>} */
  return {
    broker_connections: () => ({
      id: randomUUID(),
      environment: "production",
      status: "pending",
      status_detail: null,
      session_expires_at: null,
      last_ok_at: null,
      created_at: ts(),
      updated_at: ts(),
    }),
    broker_accounts: () => ({ id: randomUUID(), type: "individual", included: true, created_at: ts() }),
    broker_secrets: () => ({ key_version: 1, updated_at: ts() }),
    audit_events: () => ({ at: ts(), result: "ok" }),
    members: () => ({ created_at: ts() }),
  };
}

const KEYS = /** @type {Record<string, string[]>} */ ({
  broker_connections: ["id"],
  broker_accounts: ["id"],
  broker_secrets: ["connection_id"],
  members: ["user_id"],
});

/**
 * @param {unknown} a
 * @param {unknown} b
 */
function cmp(a, b) {
  const ta = typeof a === "string" ? Date.parse(a) : NaN;
  const tb = typeof b === "string" ? Date.parse(b) : NaN;
  if (Number.isFinite(ta) && Number.isFinite(tb) && /\d{4}-\d{2}-\d{2}T/.test(String(a))) return ta - tb;
  if (typeof a === "number" || typeof b === "number") return Number(a) - Number(b);
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/**
 * @param {Record<string, unknown>} row
 * @param {Record<string, unknown>} filters
 */
function matches(row, filters = {}) {
  for (const [col, cond] of Object.entries(filters)) {
    const v = row[col];
    if (cond === null) {
      if (v !== null && v !== undefined) return false;
      continue;
    }
    if (Array.isArray(cond)) {
      const [op, val] = cond;
      if (op === "in" && !(/** @type {unknown[]} */ (val)).map(String).includes(String(v))) return false;
      if (op === "eq" && String(v) !== String(val)) return false;
      if (op === "neq" && String(v) === String(val)) return false;
      if (op === "is" && !(val === null ? v === null || v === undefined : v === val)) return false;
      if (op === "lt" && !(v !== null && v !== undefined && cmp(v, val) < 0)) return false;
      if (op === "lte" && !(v !== null && v !== undefined && cmp(v, val) <= 0)) return false;
      if (op === "gt" && !(v !== null && v !== undefined && cmp(v, val) > 0)) return false;
      if (op === "gte" && !(v !== null && v !== undefined && cmp(v, val) >= 0)) return false;
      continue;
    }
    if (typeof cond === "boolean" ? v !== cond : String(v) !== String(cond)) return false;
  }
  return true;
}

/**
 * @param {{ now?: () => number }} [opts]
 */
export function createMemoryDb(opts = {}) {
  const now = opts.now ?? Date.now;
  const defs = defaults(now);
  /** @type {Map<string, Record<string, unknown>[]>} */
  const tables = new Map();
  let auditId = 0;
  /** @type {Array<{ op: string, table: string }>} */
  const calls = [];

  /** @param {string} name */
  const table = (name) => {
    let t = tables.get(name);
    if (!t) {
      t = [];
      tables.set(name, t);
    }
    return t;
  };
  /** @param {unknown} v */
  const clone = (v) => JSON.parse(JSON.stringify(v));

  /** @param {string} name @param {Record<string, unknown>} row */
  function prepare(name, row) {
    const base = defs[name]?.() ?? {};
    const out = { ...base, ...row };
    if (name === "audit_events") out.id = ++auditId;
    return out;
  }

  return {
    tables,
    calls,

    /** @param {string} name @param {{ filters?: Record<string, any>, columns?: string, order?: string, limit?: number }} [o] */
    async select(name, o = {}) {
      calls.push({ op: "select", table: name });
      let rows = table(name).filter((r) => matches(r, o.filters));
      if (o.order) {
        const [col, dir] = o.order.split(".");
        rows = [...rows].sort((a, b) => cmp(a[col], b[col]) * (dir === "desc" ? -1 : 1));
      }
      if (o.limit) rows = rows.slice(0, o.limit);
      if (o.columns && o.columns !== "*") {
        const cols = o.columns.split(",");
        rows = rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
      }
      return clone(rows);
    },

    /** @param {string} name @param {object | object[]} rows */
    async insert(name, rows) {
      calls.push({ op: "insert", table: name });
      const list = (Array.isArray(rows) ? rows : [rows]).map((r) => prepare(name, /** @type {any} */ (r)));
      const t = table(name);
      for (const r of list) {
        const keys = KEYS[name] ?? [];
        if (keys.length && t.some((x) => keys.every((k) => x[k] === r[k]))) {
          throw Object.assign(new Error("duplicate key"), { code: "23505" });
        }
        t.push(r);
      }
      return clone(list);
    },

    /** @param {string} name @param {Record<string, any>} filters @param {object} patch */
    async update(name, filters, patch) {
      calls.push({ op: "update", table: name });
      const out = [];
      for (const r of table(name)) {
        if (!matches(r, filters)) continue;
        Object.assign(r, patch);
        if ("updated_at" in r) r.updated_at = new Date(now()).toISOString();
        out.push(r);
      }
      return clone(out);
    },

    /** @param {string} name @param {object | object[]} rows @param {{ onConflict: string }} o */
    async upsert(name, rows, o) {
      calls.push({ op: "upsert", table: name });
      const keys = o.onConflict.split(",");
      const t = table(name);
      const out = [];
      for (const r of /** @type {Record<string, unknown>[]} */ (Array.isArray(rows) ? rows : [rows])) {
        const hit = t.find((x) => keys.every((k) => x[k] === r[k]));
        if (hit) {
          Object.assign(hit, r);
          if ("updated_at" in hit) hit.updated_at = new Date(now()).toISOString();
          out.push(hit);
        } else {
          const row = prepare(name, r);
          t.push(row);
          out.push(row);
        }
      }
      return clone(out);
    },

    /** @param {string} name @param {Record<string, any>} filters */
    async remove(name, filters) {
      calls.push({ op: "remove", table: name });
      const t = table(name);
      const gone = t.filter((r) => matches(r, filters));
      tables.set(name, t.filter((r) => !matches(r, filters)));
      if (name === "broker_connections") {
        const ids = gone.map((r) => r.id);
        for (const child of ["broker_accounts", "broker_secrets"]) {
          tables.set(child, table(child).filter((r) => !ids.includes(r.connection_id)));
        }
      }
      return clone(gone);
    },
  };
}
