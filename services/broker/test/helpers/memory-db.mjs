import { randomUUID } from "node:crypto";
import { ORDER_REQUEST_STATUSES } from "../../src/order-contract.mjs";

/**
 * In-memory stand-in for the PostgREST Db interface in src/db.mjs (select, insert, update, upsert,
 * remove), with the table defaults, unique keys, check constraints and cascades of
 * supabase/migrations/20261103120000_init.sql, 20261116120000_more_brokers.sql and
 * 20261121120000_order_entry.sql that the service
 * relies on. A write Postgres would refuse throws here too (code 23514 for a check, 23505 for a
 * unique key), so the service tests fail the same way production would.
 */

export const BROKER_IDS = ["ibkr", "etrade", "alpaca", "tradier", "schwab", "tastytrade", "tradestation", "webull", "fidelity", "robinhood", "moomoo", "public"];
export const METHODS = [
  "ibkr_gateway",
  "ibkr_oauth",
  "etrade_oauth1",
  "alpaca_key",
  "alpaca_oauth",
  "tradier_token",
  "tradier_oauth",
  "schwab_oauth",
  "tastytrade_oauth",
  "tradestation_oauth",
  "webull_oauth",
  "snaptrade",
];
/** broker_connections_method_broker_check */
const METHOD_BROKERS = /** @type {Record<string, string[]>} */ ({
  ibkr_gateway: ["ibkr"],
  ibkr_oauth: ["ibkr"],
  etrade_oauth1: ["etrade"],
  alpaca_key: ["alpaca"],
  alpaca_oauth: ["alpaca"],
  tradier_token: ["tradier"],
  tradier_oauth: ["tradier"],
  schwab_oauth: ["schwab"],
  tastytrade_oauth: ["tastytrade"],
  tradestation_oauth: ["tradestation"],
  webull_oauth: ["webull"],
  snaptrade: ["fidelity", "robinhood", "public", "moomoo", "webull", "schwab", "tastytrade"],
});
/** broker_connections_sandbox_check: sample data only for these methods. */
const SANDBOX_METHODS = ["etrade_oauth1", "tastytrade_oauth", "webull_oauth"];
/** broker_connections_paper_check: the user's own paper account only for these methods. */
const PAPER_METHODS = ["ibkr_gateway", "ibkr_oauth", "alpaca_key", "alpaca_oauth", "tradier_token", "tradestation_oauth"];
const HEX64 = /^[0-9a-f]{64}$/;
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:[0-9]{2,5})?$/;

/** @param {string} what */
const checkError = (what) => Object.assign(new Error(`check violation: ${what}`), { code: "23514" });
/** @param {string} what */
const uniqueError = (what) => Object.assign(new Error(`duplicate key: ${what}`), { code: "23505" });

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
      external_ref: null,
      data_as_of: null,
      scope: null,
      created_at: ts(),
      updated_at: ts(),
    }),
    broker_accounts: () => ({ id: randomUUID(), type: "individual", included: true, created_at: ts() }),
    broker_secrets: () => ({ key_version: 1, updated_at: ts() }),
    broker_oauth_pending: () => ({ stage: "start", state_hash: null, ticket_hash: null, external_ref: null, created_at: ts() }),
    broker_aggregator_users: () => ({ provider: "snaptrade", key_version: 1, created_at: ts(), updated_at: ts() }),
    audit_events: () => ({ at: ts(), result: "ok" }),
    members: () => ({ created_at: ts() }),
    // workspaces and user_settings keep no defaults: a row without orders_enabled reads as off, and
    // one without order_terms_accepted_at as not accepted (tests rely on both).
    order_requests: () => ({
      id: randomUUID(),
      user_id: null,
      connection_id: null,
      account_id: null,
      bracket: false,
      intent: "trade",
      preview: null,
      broker_state: {},
      status: "preview",
      broker_order_id: null,
      broker_order_ids: null,
      broker_messages: null,
      error: null,
      attempts: 0,
      sent_at: null,
      placed_at: null,
      reconciled_at: null,
      resolved_at: null,
      resolved_by: null,
      created_at: ts(),
      updated_at: ts(),
    }),
  };
}

const KEYS = /** @type {Record<string, string[]>} */ ({
  broker_connections: ["id"],
  broker_accounts: ["id"],
  broker_secrets: ["connection_id"],
  broker_oauth_pending: ["connection_id"],
  broker_aggregator_users: ["workspace_id"],
  members: ["user_id"],
  order_requests: ["id"],
});

/** Other unique keys (null values never collide, as in Postgres). */
const UNIQUE = /** @type {Record<string, string[][]>} */ ({
  broker_accounts: [["connection_id", "external_id"]],
  broker_oauth_pending: [["state_hash"], ["ticket_hash"]],
  broker_aggregator_users: [["external_user_id"]],
  order_requests: [["client_order_id"]],
});

/**
 * The check constraints of the migrations, per table. Throws a 23514 error.
 * @param {string} table
 * @param {Record<string, any>} r
 */
function check(table, r) {
  if (table === "broker_connections") {
    if (!BROKER_IDS.includes(r.broker_id)) throw checkError("broker_connections_broker_id_check");
    if (!METHODS.includes(r.method)) throw checkError("broker_connections_method_check");
    if (!METHOD_BROKERS[r.method].includes(r.broker_id)) throw checkError("broker_connections_method_broker_check");
    if (!["production", "sandbox", "paper"].includes(r.environment)) throw checkError("broker_connections_environment_check");
    if (!["pending", "active", "expired", "error", "disconnected"].includes(r.status)) throw checkError("broker_connections_status_check");
    if (r.environment === "sandbox" && !SANDBOX_METHODS.includes(r.method)) throw checkError("broker_connections_sandbox_check");
    if (r.environment === "paper" && !PAPER_METHODS.includes(r.method)) throw checkError("broker_connections_paper_check");
    if (r.external_ref !== null && r.external_ref !== undefined && (String(r.external_ref).length < 1 || String(r.external_ref).length > 200)) {
      throw checkError("broker_connections_external_ref_check");
    }
    if (r.scope !== null && r.scope !== undefined && String(r.scope).length > 200) throw checkError("broker_connections_scope_check");
  }
  if (table === "broker_accounts") {
    if (!BROKER_IDS.includes(r.broker_id)) throw checkError("broker_accounts_broker_id_check");
    if (!["individual", "ira", "roth", "margin", "paper"].includes(r.type)) throw checkError("broker_accounts_type_check");
  }
  if (table === "broker_oauth_pending") {
    if (!["start", "authorize", "exchanging", "claim"].includes(r.stage)) throw checkError("broker_oauth_pending_stage_check");
    if (!HEX64.test(String(r.binding_hash))) throw checkError("broker_oauth_pending_binding_hash_check");
    if (r.state_hash !== null && r.state_hash !== undefined && !HEX64.test(r.state_hash)) throw checkError("broker_oauth_pending_state_hash_check");
    if (r.ticket_hash !== null && r.ticket_hash !== undefined && !HEX64.test(r.ticket_hash)) throw checkError("broker_oauth_pending_ticket_hash_check");
    if (!ORIGIN.test(String(r.return_origin))) throw checkError("broker_oauth_pending_return_origin_check");
    if (r.external_ref !== null && r.external_ref !== undefined && (String(r.external_ref).length < 1 || String(r.external_ref).length > 200)) {
      throw checkError("broker_oauth_pending_external_ref_check");
    }
    if (!r.expires_at) throw checkError("broker_oauth_pending.expires_at not null");
  }
  if (table === "order_requests") {
    /** @param {string} col */
    const bad = (col) => checkError(`order_requests_${col}_check`);
    /** @param {unknown} v @param {number} min @param {number} max */
    const len = (v, min, max) => typeof v === "string" && v.length >= min && v.length <= max;
    if (!r.workspace_id) throw bad("workspace_id");
    if (!["ibkr", "etrade", "alpaca"].includes(r.broker_id)) throw bad("broker_id");
    if (!["ibkr_gateway", "etrade_oauth1", "alpaca_key"].includes(r.method)) throw bad("method");
    if (!["production", "paper"].includes(r.environment)) throw bad("environment");
    if (!len(r.account_display, 1, 40)) throw bad("account_display");
    if (typeof r.account_key !== "string" || !/^[0-9a-f]{16}$/.test(r.account_key)) throw bad("account_key");
    if (typeof r.client_order_id !== "string" || !/^nc[0-9a-f]{18}$/.test(r.client_order_id)) throw bad("client_order_id");
    if (typeof r.symbol !== "string" || !/^[A-Z][A-Z0-9.]{0,9}$/.test(r.symbol)) throw bad("symbol");
    if (!["BUY", "SELL"].includes(r.side)) throw bad("side");
    if (!Number.isInteger(r.quantity) || r.quantity < 1 || r.quantity > 1_000_000) throw bad("quantity");
    if (!["MKT", "LMT", "STP", "STP_LMT"].includes(r.order_type)) throw bad("order_type");
    if (!["DAY", "GTC"].includes(r.tif)) throw bad("tif");
    if (!["trade", "close"].includes(r.intent)) throw bad("intent");
    if (!ORDER_REQUEST_STATUSES.includes(r.status)) throw bad("status");
    if (r.broker_order_id !== null && r.broker_order_id !== undefined && !len(r.broker_order_id, 1, 64)) throw bad("broker_order_id");
    if (r.error !== null && r.error !== undefined && !len(r.error, 0, 500)) throw bad("error");
    if (!Number.isInteger(r.attempts) || r.attempts < 0 || r.attempts > 10) throw bad("attempts");
    if (!r.expires_at) throw bad("expires_at");
    if (!r.request || typeof r.request !== "object" || Array.isArray(r.request)) throw bad("request");
  }
  if (table === "broker_aggregator_users") {
    if (r.provider !== "snaptrade") throw checkError("broker_aggregator_users_provider_check");
    if (!r.external_user_id || String(r.external_user_id).length > 200) throw checkError("broker_aggregator_users_external_user_id_check");
    if (!r.iv || !r.tag || !r.ciphertext) throw checkError("broker_aggregator_users not null");
  }
}

/**
 * Unique keys and the partial unique index broker_connections_one_login_idx.
 * @param {string} table
 * @param {Record<string, any>} r the row as it would be
 * @param {Record<string, any>[]} rows the other rows of the table
 */
function unique(table, r, rows) {
  for (const cols of UNIQUE[table] ?? []) {
    if (cols.some((c) => r[c] === null || r[c] === undefined)) continue;
    if (rows.some((x) => cols.every((c) => x[c] === r[c]))) throw uniqueError(`${table}(${cols.join(",")})`);
  }
  if (table === "broker_connections" && r.external_ref && r.status !== "disconnected") {
    const clash = rows.some(
      (x) =>
        x.external_ref === r.external_ref &&
        x.status !== "disconnected" &&
        x.workspace_id === r.workspace_id &&
        x.broker_id === r.broker_id &&
        x.environment === r.environment,
    );
    if (clash) throw uniqueError("broker_connections_one_login_idx");
  }
}

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
  /** Throw this from the next write to `table` (tests of a failed database write). */
  /** @type {Map<string, Error>} */
  const failNext = new Map();

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

  /** @param {string} name */
  function maybeFail(name) {
    const e = failNext.get(name);
    if (e) {
      failNext.delete(name);
      throw e;
    }
  }

  /** @param {string} name */
  function cascade(name, /** @type {Record<string, unknown>[]} */ gone) {
    if (name === "broker_connections") {
      const ids = gone.map((r) => r.id);
      const accountIds = table("broker_accounts")
        .filter((r) => ids.includes(r.connection_id))
        .map((r) => r.id);
      for (const child of ["broker_accounts", "broker_secrets", "broker_oauth_pending"]) {
        tables.set(child, table(child).filter((r) => !ids.includes(r.connection_id)));
      }
      // order_requests keep their record of what was sent: the references become null.
      for (const r of table("order_requests")) {
        if (ids.includes(r.connection_id)) r.connection_id = null;
        if (accountIds.includes(r.account_id)) r.account_id = null;
      }
    }
    if (name === "broker_accounts") {
      const ids = gone.map((r) => r.id);
      for (const r of table("order_requests")) if (ids.includes(r.account_id)) r.account_id = null;
    }
  }

  return {
    tables,
    calls,
    failNext,

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
      maybeFail(name);
      const list = (Array.isArray(rows) ? rows : [rows]).map((r) => prepare(name, /** @type {any} */ (r)));
      const t = table(name);
      for (const r of list) {
        const keys = KEYS[name] ?? [];
        if (keys.length && t.some((x) => keys.every((k) => x[k] === r[k]))) throw uniqueError(name);
        check(name, r);
        unique(name, r, t);
        t.push(r);
      }
      return clone(list);
    },

    /** @param {string} name @param {Record<string, any>} filters @param {object} patch */
    async update(name, filters, patch) {
      calls.push({ op: "update", table: name });
      maybeFail(name);
      const t = table(name);
      const hits = t.filter((r) => matches(r, filters));
      // Checked first, written after: a refused UPDATE changes nothing, as in Postgres.
      for (const r of hits) {
        const next = { ...r, ...patch };
        check(name, next);
        unique(
          name,
          next,
          t.filter((x) => x !== r),
        );
      }
      for (const r of hits) {
        Object.assign(r, patch);
        if ("updated_at" in r) r.updated_at = new Date(now()).toISOString();
      }
      return clone(hits);
    },

    /** @param {string} name @param {object | object[]} rows @param {{ onConflict: string }} o */
    async upsert(name, rows, o) {
      calls.push({ op: "upsert", table: name });
      maybeFail(name);
      const keys = o.onConflict.split(",");
      const t = table(name);
      const out = [];
      for (const r of /** @type {Record<string, unknown>[]} */ (Array.isArray(rows) ? rows : [rows])) {
        const hit = t.find((x) => keys.every((k) => x[k] === r[k]));
        if (hit) {
          const next = { ...hit, ...r };
          check(name, next);
          unique(
            name,
            next,
            t.filter((x) => x !== hit),
          );
          Object.assign(hit, r);
          if ("updated_at" in hit) hit.updated_at = new Date(now()).toISOString();
          out.push(hit);
        } else {
          const row = prepare(name, r);
          check(name, row);
          unique(name, row, t);
          t.push(row);
          out.push(row);
        }
      }
      return clone(out);
    },

    /** @param {string} name @param {Record<string, any>} filters */
    async remove(name, filters) {
      calls.push({ op: "remove", table: name });
      maybeFail(name);
      const t = table(name);
      const gone = t.filter((r) => matches(r, filters));
      tables.set(
        name,
        t.filter((r) => !matches(r, filters)),
      );
      cascade(name, gone);
      return clone(gone);
    },
  };
}
