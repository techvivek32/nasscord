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
 * The broker ids and connect methods of supabase/migrations/20261116120000_more_brokers.sql.
 * @typedef {import("./mapping.mjs").BrokerId} BrokerId
 * @typedef {"ibkr_gateway" | "ibkr_oauth" | "etrade_oauth1" | "alpaca_key" | "alpaca_oauth" | "tradier_token" | "tradier_oauth"
 *   | "schwab_oauth" | "tastytrade_oauth" | "tradestation_oauth" | "webull_oauth" | "snaptrade"} ConnectionMethod
 * @typedef {"production" | "sandbox" | "paper"} Environment
 * @typedef {"pending" | "active" | "expired" | "error" | "disconnected"} ConnectionStatus
 * @typedef {{
 *   id: string, workspace_id: string, user_id: string,
 *   broker_id: BrokerId,
 *   method: ConnectionMethod,
 *   environment: Environment,
 *   status: ConnectionStatus,
 *   status_detail: string | null,
 *   session_expires_at: string | null,
 *   last_ok_at: string | null,
 *   external_ref?: string | null,
 *   data_as_of?: string | null,
 *   scope?: string | null,
 *   created_at: string, updated_at: string,
 * }} ConnectionRow
 * @typedef {{
 *   id: string, connection_id: string, workspace_id: string, broker_id: BrokerId,
 *   external_id: string, display_number: string, label: string,
 *   type: "individual" | "ira" | "roth" | "margin" | "paper",
 *   included: boolean, created_at: string,
 * }} AccountRow
 * @typedef {Pick<AccountRow, "connection_id" | "workspace_id" | "broker_id" | "external_id" | "display_number" | "label" | "type">} AccountRowInput
 * @typedef {"start" | "authorize" | "exchanging" | "claim"} PendingStage
 * @typedef {{
 *   connection_id: string, stage: PendingStage, binding_hash: string,
 *   state_hash: string | null, ticket_hash: string | null,
 *   return_origin: string, external_ref: string | null,
 *   expires_at: string, created_at: string,
 * }} PendingRow
 * @typedef {"preview" | "sending" | "placed" | "rejected" | "unknown" | "needs_confirmation" | "cancel_requested" | "cancelled"} OrderRequestStatus
 * @typedef {{
 *   id: string, workspace_id: string, user_id: string | null, connection_id: string | null, account_id: string | null,
 *   account_key: string,
 *   broker_id: "ibkr" | "etrade" | "alpaca", method: "ibkr_gateway" | "etrade_oauth1" | "alpaca_key",
 *   environment: "production" | "paper", account_display: string, client_order_id: string,
 *   symbol: string, side: "BUY" | "SELL", quantity: number, order_type: "MKT" | "LMT" | "STP" | "STP_LMT",
 *   tif: "DAY" | "GTC", bracket: boolean, intent: "trade" | "close",
 *   request: any, preview: any, broker_state: Record<string, unknown>, status: OrderRequestStatus,
 *   broker_order_id: string | null, broker_order_ids: any, broker_messages: any, error: string | null, attempts: number,
 *   expires_at: string, sent_at: string | null, placed_at: string | null, reconciled_at: string | null,
 *   resolved_at: string | null, resolved_by: string | null,
 *   created_at: string, updated_at: string,
 * }} OrderRequestRow
 *   One order ticket previewed in Nasscord (supabase/migrations/20261121120000_order_entry.sql).
 * @typedef {{ id: string, status: string, orders_enabled?: boolean | null, owner_id: string | null }} OrderGateWorkspace
 * @typedef {{ role: string, workspace_id: string | null }} OrderGateMember
 * @typedef {{
 *   workspace_id: string, provider: "snaptrade", external_user_id: string,
 *   key_version: number, iv: string, tag: string, ciphertext: string,
 *   created_at: string, updated_at: string,
 * }} AggregatorUserRow
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

    /** @param {string} id @returns {Promise<AccountRow | null>} */
    async getAccount(id) {
      return first(await db.select("broker_accounts", { filters: { id } }));
    },

    /**
     * Every broker_accounts.id with this broker and broker account number, in any workspace: the
     * same account can sit under two connections (order duplicate checks key on the account).
     * @param {string} brokerId
     * @param {string} externalId
     * @returns {Promise<string[]>}
     */
    async accountIdsFor(brokerId, externalId) {
      const rows = await db.select("broker_accounts", { filters: { broker_id: brokerId, external_id: externalId }, columns: "id" });
      return rows.map((r) => String(r.id));
    },

    /**
     * The order gate's rows: the workspace (status, switch, owner) and the caller's members row.
     * Errors propagate (a missing column, 42703, included): the order core treats any error as off.
     * @param {string} workspaceId
     * @param {string} userId
     * @returns {Promise<{ workspace: OrderGateWorkspace | null, member: OrderGateMember | null }>}
     */
    async orderGate(workspaceId, userId) {
      const [ws, members] = await Promise.all([
        db.select("workspaces", { filters: { id: workspaceId }, columns: "id,status,orders_enabled,owner_id" }),
        db.select("members", { filters: { user_id: userId }, columns: "role,workspace_id" }),
      ]);
      return { workspace: first(ws), member: first(members) };
    },

    // ── order_requests: one row per order ticket previewed in Nasscord (no secrets)

    /** @param {Partial<OrderRequestRow>} row @returns {Promise<OrderRequestRow>} */
    async insertOrderRequest(row) {
      return first(await db.insert("order_requests", row));
    },

    /** @param {string} id @returns {Promise<OrderRequestRow | null>} */
    async getOrderRequest(id) {
      return first(await db.select("order_requests", { filters: { id } }));
    },

    /**
     * @param {string} id
     * @param {Partial<OrderRequestRow>} patch
     * @returns {Promise<OrderRequestRow | null>}
     */
    async updateOrderRequest(id, patch) {
      return first(await db.update("order_requests", { id }, patch));
    },

    /**
     * Moves a row on only while it still has one of `fromStatuses` and has not expired: one
     * conditional UPDATE, so two place calls cannot both claim one ticket. Null: another call
     * claimed it first, or it expired. With `clientOrderId`, the row must also still carry that client
     * order id: a confirmation round rotates it, so a claim names the exact attempt it validated.
     * @param {string} id
     * @param {OrderRequestStatus[]} fromStatuses
     * @param {Partial<OrderRequestRow>} patch
     * @param {{ notExpiredAt: string, clientOrderId?: string }} opts
     * @returns {Promise<OrderRequestRow | null>}
     */
    async claimOrderRequest(id, fromStatuses, patch, { notExpiredAt, clientOrderId }) {
      /** @type {Filters} */
      const filters = { id, status: ["in", fromStatuses], expires_at: ["gt", notExpiredAt] };
      if (clientOrderId) filters.client_order_id = clientOrderId;
      return first(await db.update("order_requests", filters, patch));
    },

    /**
     * @param {Filters} filters
     * @param {{ order?: string, limit?: number }} [opts]
     * @returns {Promise<OrderRequestRow[]>}
     */
    listOrderRequests(filters, { order = "created_at.desc", limit = 50 } = {}) {
      return db.select("order_requests", { filters, order, limit });
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

    /**
     * The workspace's live connection for one broker login (external_ref), if any: what the
     * one-login unique index allows once. Disconnected rows do not count. Any method of the broker:
     * the index has no method column, so one broker login is one connection whichever way it was
     * connected (a merge moves the row to the method of the newest login, flows.mjs).
     * @param {{ workspaceId: string, brokerId: string, environment: string, externalRef: string }} q
     * @returns {Promise<ConnectionRow | null>}
     */
    async findConnectionByRef(q) {
      return first(
        await db.select("broker_connections", {
          filters: {
            workspace_id: q.workspaceId,
            broker_id: q.brokerId,
            environment: q.environment,
            external_ref: q.externalRef,
            status: ["neq", "disconnected"],
          },
          order: "created_at.asc",
        }),
      );
    },

    // ── broker_oauth_pending: the hand-off of an OAuth or aggregator login (hashes only)

    /**
     * Creates the hand-off row of a login, replacing an earlier one of the same connection (a
     * Reconnect starts a new login).
     * @param {Pick<PendingRow, "connection_id" | "binding_hash" | "return_origin" | "expires_at">} row
     * @returns {Promise<PendingRow>}
     */
    async putPending(row) {
      const rows = await db.upsert(
        "broker_oauth_pending",
        { ...row, stage: "start", state_hash: null, ticket_hash: null, external_ref: null },
        { onConflict: "connection_id" },
      );
      return first(rows);
    },

    /** @param {string} connectionId @returns {Promise<PendingRow | null>} */
    async getPending(connectionId) {
      return first(await db.select("broker_oauth_pending", { filters: { connection_id: connectionId } }));
    },

    /**
     * Moves a hand-off row on only while it is still in one of `stages` (one atomic UPDATE, so two
     * requests racing for the same row cannot both win). Returns the row, or null when another
     * request moved it first or it is gone.
     * @param {Filters} where e.g. { connection_id } or { state_hash }
     * @param {PendingStage[]} stages
     * @param {Partial<PendingRow>} patch
     * @returns {Promise<PendingRow | null>}
     */
    async advancePending(where, stages, patch) {
      return first(await db.update("broker_oauth_pending", { ...where, stage: ["in", stages] }, patch));
    },

    /**
     * Takes the hand-off row a claim names, once: DELETE ... RETURNING on the connection, the
     * ticket hash and the claim stage. A second claim with the same ticket finds nothing.
     * @param {string} connectionId
     * @param {string} ticketHash
     * @returns {Promise<PendingRow | null>}
     */
    async takePendingClaim(connectionId, ticketHash) {
      return first(await db.remove("broker_oauth_pending", { connection_id: connectionId, ticket_hash: ticketHash, stage: "claim" }));
    },

    /**
     * Removes a connection's hand-off row and answers it (null when there was none).
     * @param {string} connectionId
     * @returns {Promise<PendingRow | null>}
     */
    async deletePending(connectionId) {
      return first(await db.remove("broker_oauth_pending", { connection_id: connectionId }));
    },

    /**
     * Hand-off rows whose window has passed.
     * @param {string} nowIso
     * @returns {Promise<PendingRow[]>}
     */
    listExpiredPending(nowIso) {
      return db.select("broker_oauth_pending", { filters: { expires_at: ["lte", nowIso] }, order: "expires_at.asc", limit: 200 });
    },

    // ── broker_aggregator_users: one SnapTrade user per workspace (userSecret sealed)

    /** @param {string} workspaceId @returns {Promise<AggregatorUserRow | null>} */
    async getAggregatorUser(workspaceId) {
      return first(await db.select("broker_aggregator_users", { filters: { workspace_id: workspaceId } }));
    },

    /**
     * @param {Pick<AggregatorUserRow, "workspace_id" | "external_user_id" | "key_version" | "iv" | "tag" | "ciphertext"> & { provider?: "snaptrade" }} row
     * @returns {Promise<AggregatorUserRow>}
     */
    async putAggregatorUser(row) {
      return first(await db.upsert("broker_aggregator_users", { provider: "snaptrade", ...row }, { onConflict: "workspace_id" }));
    },

    /** @param {string} workspaceId */
    async deleteAggregatorUser(workspaceId) {
      await db.remove("broker_aggregator_users", { workspace_id: workspaceId });
    },
  };
}

/** @typedef {ReturnType<typeof createStore>} Store */
