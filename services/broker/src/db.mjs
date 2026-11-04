/**
 * Database access through Supabase PostgREST (`/rest/v1`) with the service role.
 *
 * Two layers:
 * - `createDb`: five generic table calls (select, insert, update, upsert, remove). Tests swap it for
 *   an in-memory implementation of the same five calls.
 * - `createStore`: the handful of queries the service needs, written once against that interface.
 */

/**
 * A filter value: a plain value means "equals", null means "is null",
 * or a tuple [operator, value] with operator eq | neq | lt | lte | gt | gte | in | is.
 * @typedef {string | number | boolean | null | [string, unknown]} Filter
 * @typedef {Record<string, Filter>} Filters
 * @typedef {{ filters?: Filters, columns?: string, order?: string, limit?: number }} SelectOpts
 * @typedef {{
 *   select: (table: string, opts?: SelectOpts) => Promise<any[]>,
 *   insert: (table: string, rows: object | object[]) => Promise<any[]>,
 *   update: (table: string, filters: Filters, patch: object) => Promise<any[]>,
 *   upsert: (table: string, rows: object | object[], opts: { onConflict: string }) => Promise<any[]>,
 *   remove: (table: string, filters: Filters) => Promise<any[]>,
 * }} Db
 */

export class DbError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string }} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = "DbError";
    this.status = opts.status ?? 0;
    this.code = opts.code ?? "";
  }
}

const OPS = new Set(["eq", "neq", "lt", "lte", "gt", "gte", "in", "is"]);
const COLUMN = /^[a-z_][a-z0-9_]*$/;

/**
 * @param {string} col
 * @param {Filter} cond
 */
export function encodeFilter(col, cond) {
  if (!COLUMN.test(col)) throw new DbError(`bad column name ${col}`);
  if (cond === null) return `${col}=is.null`;
  if (Array.isArray(cond)) {
    const [op, val] = cond;
    if (!OPS.has(op)) throw new DbError(`bad operator ${op}`);
    if (op === "in") {
      if (!Array.isArray(val)) throw new DbError("in needs a list");
      const list = val.map((v) => `"${String(v).replace(/["\\]/g, "\\$&")}"`).join(",");
      return `${col}=in.${encodeURIComponent(`(${list})`)}`;
    }
    if (op === "is") return `${col}=is.${val === null ? "null" : val ? "true" : "false"}`;
    return `${col}=${op}.${encodeURIComponent(String(val))}`;
  }
  return `${col}=eq.${encodeURIComponent(String(cond))}`;
}

/** @param {Filters | undefined} filters */
function filterQuery(filters) {
  return Object.entries(filters ?? {}).map(([k, v]) => encodeFilter(k, v));
}

/**
 * PostgREST over fetch.
 * @param {{ url: string, serviceRoleKey: string, fetch?: typeof fetch, timeoutMs?: number }} opts
 * @returns {Db}
 */
export function createDb({ url, serviceRoleKey, fetch: doFetch = globalThis.fetch, timeoutMs = 10_000 }) {
  const base = `${url.replace(/\/+$/, "")}/rest/v1`;
  /** @type {Record<string, string>} */
  const auth = { apikey: serviceRoleKey };
  // Legacy service_role keys are JWTs and go in Authorization too. The newer sb_secret_ keys are not
  // JWTs, and PostgREST rejects a non-JWT bearer, so those travel in `apikey` alone.
  if (serviceRoleKey.split(".").length === 3) auth.authorization = `Bearer ${serviceRoleKey}`;

  /**
   * @param {string} method
   * @param {string} table
   * @param {string[]} query
   * @param {{ body?: unknown, prefer?: string }} [opts]
   */
  async function call(method, table, query, opts = {}) {
    if (!COLUMN.test(table)) throw new DbError(`bad table name ${table}`);
    const qs = query.length ? `?${query.join("&")}` : "";
    /** @type {Record<string, string>} */
    const headers = { ...auth, accept: "application/json" };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.prefer) headers.prefer = opts.prefer;
    let res;
    try {
      res = await doFetch(`${base}/${table}${qs}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new DbError(`database request failed: ${/** @type {Error} */ (e).name}`, { code: "network" });
    }
    const text = await res.text();
    if (!res.ok) {
      let code = "";
      let message = `database answered ${res.status}`;
      try {
        const j = JSON.parse(text);
        code = String(j.code ?? "");
        if (j.message) message = `${message}: ${String(j.message).slice(0, 200)}`;
      } catch {
        /* not JSON */
      }
      throw new DbError(message, { status: res.status, code });
    }
    if (!text) return [];
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [data];
  }

  return {
    select(table, opts = {}) {
      const q = [`select=${encodeURIComponent(opts.columns ?? "*")}`, ...filterQuery(opts.filters)];
      if (opts.order) q.push(`order=${encodeURIComponent(opts.order)}`);
      if (opts.limit) q.push(`limit=${Number(opts.limit)}`);
      return call("GET", table, q);
    },
    insert(table, rows) {
      return call("POST", table, [], { body: rows, prefer: "return=representation" });
    },
    update(table, filters, patch) {
      const q = filterQuery(filters);
      if (!q.length) throw new DbError("refusing to update without a filter");
      return call("PATCH", table, q, { body: patch, prefer: "return=representation" });
    },
    upsert(table, rows, { onConflict }) {
      return call("POST", table, [`on_conflict=${encodeURIComponent(onConflict)}`], {
        body: rows,
        prefer: "resolution=merge-duplicates,return=representation",
      });
    },
    remove(table, filters) {
      const q = filterQuery(filters);
      if (!q.length) throw new DbError("refusing to delete without a filter");
      return call("DELETE", table, q, { prefer: "return=representation" });
    },
  };
}

/**
 * @typedef {{
 *   id: string, workspace_id: string, user_id: string,
 *   broker_id: "ibkr" | "etrade",
 *   method: "ibkr_gateway" | "ibkr_oauth" | "etrade_oauth1",
 *   environment: "production" | "sandbox" | "paper",
 *   status: "pending" | "active" | "expired" | "error" | "disconnected",
 *   status_detail: string | null,
 *   session_expires_at: string | null,
 *   last_ok_at: string | null,
 *   created_at: string, updated_at: string,
 * }} ConnectionRow
 * @typedef {{
 *   id: string, connection_id: string, workspace_id: string, broker_id: "ibkr" | "etrade",
 *   external_id: string, display_number: string, label: string,
 *   type: "individual" | "ira" | "roth" | "margin" | "paper",
 *   included: boolean, created_at: string,
 * }} AccountRow
 */

/**
 * The queries the service runs. Every one goes through the Db interface above.
 * @param {Db} db
 */
export function createStore(db) {
  /** @param {any[]} rows */
  const first = (rows) => rows[0] ?? null;

  return {
    db,

    /** @param {string} id @returns {Promise<ConnectionRow | null>} */
    async getConnection(id) {
      return first(await db.select("broker_connections", { filters: { id } }));
    },

    /**
     * @param {Filters} filters
     * @returns {Promise<ConnectionRow[]>}
     */
    listConnections(filters) {
      return db.select("broker_connections", { filters, order: "created_at.asc" });
    },

    /** @param {object} row @returns {Promise<ConnectionRow>} */
    async insertConnection(row) {
      return first(await db.insert("broker_connections", row));
    },

    /**
     * @param {string} id
     * @param {Partial<ConnectionRow>} patch
     * @returns {Promise<ConnectionRow | null>}
     */
    async updateConnection(id, patch) {
      return first(await db.update("broker_connections", { id }, patch));
    },

    /**
     * Update only while the row still has one of the given statuses (guards against a race with
     * the scheduler or a second tab).
     * @param {string} id
     * @param {string[]} statuses
     * @param {Partial<ConnectionRow>} patch
     */
    async updateConnectionIf(id, statuses, patch) {
      return first(await db.update("broker_connections", { id, status: ["in", statuses] }, patch));
    },

    /** @param {string} id */
    async deleteConnection(id) {
      await db.remove("broker_connections", { id });
    },

    /**
     * @param {string[]} connectionIds
     * @param {{ includedOnly?: boolean }} [opts]
     * @returns {Promise<AccountRow[]>}
     */
    async listAccounts(connectionIds, opts = {}) {
      if (!connectionIds.length) return [];
      /** @type {Filters} */
      const filters = { connection_id: ["in", connectionIds] };
      if (opts.includedOnly) filters.included = true;
      return db.select("broker_accounts", { filters, order: "created_at.asc" });
    },

    /**
     * Inserts new accounts and refreshes label, number and type of known ones. `included` is not
     * sent, so a user's choice survives a refresh.
     * @param {Array<Pick<AccountRow, "connection_id" | "workspace_id" | "broker_id" | "external_id" | "display_number" | "label" | "type">>} rows
     * @returns {Promise<AccountRow[]>}
     */
    upsertAccounts(rows) {
      if (!rows.length) return Promise.resolve([]);
      return db.upsert("broker_accounts", rows, { onConflict: "connection_id,external_id" });
    },

    /** @param {string} connectionId */
    async deleteAccounts(connectionId) {
      await db.remove("broker_accounts", { connection_id: connectionId });
    },

    /**
     * Removes the connection's accounts whose broker number is not in `keep` (an earlier login
     * with another username). Returns how many were removed.
     * @param {string} connectionId
     * @param {string[]} keep external ids of the accounts the broker lists now
     */
    async pruneAccounts(connectionId, keep) {
      const rows = await db.select("broker_accounts", { filters: { connection_id: connectionId }, columns: "id,external_id" });
      const stale = rows.filter((r) => !keep.includes(r.external_id)).map((r) => r.id);
      if (!stale.length) return 0;
      await db.remove("broker_accounts", { connection_id: connectionId, id: ["in", stale] });
      return stale.length;
    },

    /** @param {string} connectionId */
    async getSecret(connectionId) {
      return first(await db.select("broker_secrets", { filters: { connection_id: connectionId } }));
    },

    /** @param {{ connection_id: string, key_version: number, iv: string, tag: string, ciphertext: string }} row */
    async putSecret(row) {
      await db.upsert("broker_secrets", row, { onConflict: "connection_id" });
    },

    /** @param {string} connectionId */
    async deleteSecret(connectionId) {
      await db.remove("broker_secrets", { connection_id: connectionId });
    },

    /** @param {object} row */
    async insertAudit(row) {
      await db.insert("audit_events", row);
    },

    /** @param {string} workspaceId @returns {Promise<string | null>} */
    async workspaceName(workspaceId) {
      const row = first(await db.select("workspaces", { filters: { id: workspaceId }, columns: "name" }));
      return row?.name ?? null;
    },

    /** @param {string} userId @returns {Promise<string | null>} */
    async memberEmail(userId) {
      const row = first(await db.select("members", { filters: { user_id: userId }, columns: "email" }));
      return row?.email ?? null;
    },

    /** @returns {Promise<Array<{ broker_id: string, status: string }>>} */
    connectionStatuses() {
      return db.select("broker_connections", { columns: "broker_id,status" });
    },
  };
}

/** @typedef {ReturnType<typeof createStore>} Store */
