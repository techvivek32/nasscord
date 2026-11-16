import { randomBytes } from "node:crypto";
import { conflict, unavailable } from "../errors.mjs";

/**
 * One SnapTrade user per workspace (broker_aggregator_users).
 *
 * - userId: the workspace id (never an email). When SnapTrade still holds that id (a user deleted a
 *   moment ago stays taken until SnapTrade finishes deleting it), "<workspace id>-<8 hex>" instead;
 *   external_user_id always records the id in use.
 * - userSecret: SnapTrade shows it once, at registration. It is sealed with BROKER_TOKEN_KEY
 *   (AES-256-GCM, AAD "snaptrade:<workspace id>", the key_version rotation of broker_secrets) and
 *   kept decrypted in memory for a few minutes.
 * - The user goes when the workspace's last SnapTrade connection goes (Disconnect, or the sweep for
 *   one left behind), which stops SnapTrade's per-user billing.
 * - The row cascades when its workspace (or the Nasscord account owning it) is deleted, which no
 *   service code sees. The sweep then finds the SnapTrade user in SnapTrade's own list and deletes
 *   it (deleteStrays), so its broker connections and billing do not outlive the workspace.
 * Registration and deletion of one workspace run under the lock "snaptrade-user:<workspace id>".
 */

const MEMO_MS = 5 * 60_000;

/** The SnapTrade user ids this file makes: the workspace id, or "<workspace id>-<8 hex>". */
export const SNAPTRADE_USER_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-[0-9a-f]{8})?$/i;

/** @typedef {import("./client.mjs").SnapUser} SnapUser */

/**
 * @param {{
 *   store: import("../db.mjs").Store,
 *   secretBox: import("../secrets.mjs").SecretBox,
 *   locks: import("../locks.mjs").Locks,
 *   client: () => import("./client.mjs").SnapTradeClient,
 *   log: import("../log.mjs").Logger,
 *   now: () => number,
 * }} deps
 */
export function createSnapTradeUsers(deps) {
  const { store, secretBox, locks, log, now } = deps;
  /** @type {Map<string, SnapUser & { at: number }>} */
  const memo = new Map();
  /** SnapTrade user ids seen without a row, and when first seen so. */
  /** @type {Map<string, number>} */
  const unclaimed = new Map();

  /** @param {string} wid */
  const aad = (wid) => `snaptrade:${wid}`;
  /** @param {string} wid */
  const lockKey = (wid) => `snaptrade-user:${wid}`;

  /**
   * The stored user of a workspace, decrypted (and sealed again with the current key when it was
   * sealed with an older one), or null.
   * @param {string} wid
   * @returns {Promise<SnapUser | null>}
   */
  async function read(wid) {
    const row = await store.getAggregatorUser(wid);
    if (!row) return null;
    const plain = secretBox.decrypt(aad(wid), row);
    const userSecret = typeof plain?.userSecret === "string" ? plain.userSecret : "";
    if (!userSecret) throw new Error("snaptrade: the stored user has no secret");
    const user = { userId: row.external_user_id, userSecret };
    if (secretBox.needsRotation(row)) {
      await store
        .putAggregatorUser({ workspace_id: wid, external_user_id: row.external_user_id, ...secretBox.encrypt(aad(wid), { userSecret }) })
        .catch((e) => log.warn("snaptrade user not sealed again with the current key", { workspaceId: wid, error: e }));
    }
    return user;
  }

  /** @param {string} wid @returns {Promise<SnapUser | null>} */
  async function get(wid) {
    const hit = memo.get(wid);
    if (hit && now() - hit.at < MEMO_MS) return { userId: hit.userId, userSecret: hit.userSecret };
    const user = await read(wid);
    if (user) memo.set(wid, { ...user, at: now() });
    else memo.delete(wid);
    return user;
  }

  /**
   * Registers a SnapTrade user for the workspace and stores its secret. When the store refuses the
   * row, the new user is deleted again at once (its secret would be lost).
   * @param {string} wid
   * @returns {Promise<SnapUser>}
   */
  async function register(wid) {
    const api = deps.client();
    for (const userId of [wid, `${wid}-${randomBytes(4).toString("hex")}`]) {
      const out = await api.registerUser(userId);
      if ("exists" in out) {
        log.info("snaptrade user id already taken; trying another", { workspaceId: wid });
        continue;
      }
      try {
        await store.putAggregatorUser({ workspace_id: wid, external_user_id: userId, ...secretBox.encrypt(aad(wid), { userSecret: out.userSecret }) });
      } catch (e) {
        await api.deleteUser(userId).catch((e2) => log.warn("snaptrade user registered but not stored, and not deleted", { workspaceId: wid, error: e2 }));
        throw e;
      }
      log.info("snaptrade user registered", { workspaceId: wid });
      memo.set(wid, { userId, userSecret: out.userSecret, at: now() });
      return { userId, userSecret: out.userSecret };
    }
    throw conflict("SnapTrade is still removing this workspace's earlier connection data. Try again in a few minutes.", "snaptrade_user_taken");
  }

  /**
   * The workspace of a SnapTrade userId (webhooks, the sweep), or null.
   * @param {string} userId
   * @returns {Promise<string | null>}
   */
  async function workspaceOf(userId) {
    if (typeof userId !== "string" || !userId || userId.length > 200) return null;
    const rows = await store.db.select("broker_aggregator_users", { filters: { external_user_id: userId }, columns: "workspace_id", limit: 1 });
    return rows[0]?.workspace_id ?? null;
  }

  return {
    get,

    /**
     * The workspace's SnapTrade user, registered on first use.
     * @param {string} wid
     * @returns {Promise<SnapUser>}
     */
    ensure(wid) {
      return locks.run(lockKey(wid), async () => (await get(wid)) ?? register(wid));
    },

    /**
     * Deletes the workspace's SnapTrade user (at SnapTrade, then the row) when no SnapTrade
     * connection of the workspace other than `except` is left (a login in progress counts).
     * @param {string} wid
     * @param {{ except?: string }} [o]
     * @returns {Promise<"deleted" | "kept" | "none">}
     */
    dropIfUnused(wid, o = {}) {
      return locks.run(lockKey(wid), async () => {
        const live = await store.listConnections({ workspace_id: wid, method: "snaptrade", status: ["neq", "disconnected"] });
        if (live.some((c) => c.id !== o.except)) return "kept";
        const row = await store.getAggregatorUser(wid);
        if (!row) {
          memo.delete(wid);
          return "none";
        }
        await deps.client().deleteUser(row.external_user_id);
        await store.deleteAggregatorUser(wid);
        memo.delete(wid);
        log.info("snaptrade user deleted (no connection left)", { workspaceId: wid });
        return "deleted";
      });
    },

    workspaceOf,

    /**
     * Every workspace with a SnapTrade user (the sweep), read in pages of 500 by workspace id.
     * @returns {Promise<Array<{ workspace_id: string, external_user_id: string, created_at: string }>>}
     */
    async list() {
      /** @type {Array<{ workspace_id: string, external_user_id: string, created_at: string }>} */
      const out = [];
      /** @type {string | null} */
      let last = null;
      for (let page = 0; page < 200; page++) {
        const rows = await store.db.select("broker_aggregator_users", {
          columns: "workspace_id,external_user_id,created_at",
          filters: last ? { workspace_id: ["gt", last] } : {},
          order: "workspace_id.asc",
          limit: 500,
        });
        out.push(...rows);
        if (rows.length < 500) break;
        last = rows[rows.length - 1].workspace_id;
      }
      return out;
    },

    /**
     * Deletes SnapTrade users of Nasscord's keys that no workspace holds any more. One goes only
     * when its id is one this file makes, it has been seen without a row for `minAgeMs` (a
     * registration in progress writes its row a moment after SnapTrade answers), and a fresh look
     * under the workspace's lock still finds no row. When more users than max(3, a tenth of the
     * list) look like that, nothing is deleted and a warning is logged: this database is probably
     * not the one these SnapTrade keys belong to.
     * @param {string[]} listed every user id SnapTrade lists
     * @param {Set<string>} known external_user_id of every broker_aggregator_users row
     * @param {{ minAgeMs: number }} o
     * @returns {Promise<number>} how many were deleted
     */
    async deleteStrays(listed, known, o) {
      const t = now();
      const strays = listed.filter((id) => !known.has(id) && SNAPTRADE_USER_ID.test(id));
      const current = new Set(strays);
      for (const id of [...unclaimed.keys()]) if (!current.has(id)) unclaimed.delete(id);
      if (strays.length > Math.max(3, Math.floor(listed.length / 10))) {
        log.warn("snaptrade lists more users without a workspace than expected; none deleted", { strays: strays.length, listed: listed.length });
        return 0;
      }
      let deleted = 0;
      for (const id of strays) {
        const since = unclaimed.get(id);
        if (since === undefined) {
          unclaimed.set(id, t);
          continue;
        }
        if (t - since < o.minAgeMs) continue;
        const wid = /** @type {RegExpExecArray} */ (SNAPTRADE_USER_ID.exec(id))[1].toLowerCase();
        const gone = await locks.run(lockKey(wid), async () => {
          if (await workspaceOf(id)) return false;
          await deps.client().deleteUser(id);
          return true;
        });
        unclaimed.delete(id);
        if (!gone) continue;
        deleted++;
        log.info("snaptrade user without a workspace deleted", { workspaceId: wid });
      }
      return deleted;
    },

    /** @param {string} wid */
    forget(wid) {
      memo.delete(wid);
    },
  };
}

/** The sentence when SnapTrade is not set up (no keys). */
export const notSetUp = () => unavailable("SnapTrade is not set up on this server yet.", "not_configured");

/** @typedef {ReturnType<typeof createSnapTradeUsers>} SnapTradeUsers */
