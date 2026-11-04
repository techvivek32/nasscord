/**
 * Writes `audit_events` rows for start, verify, renew, disconnect and system expiries
 * (contract section 6). Auditing never breaks the action it records: a failed write is logged.
 */

/**
 * @typedef {{ sub: string, wid: string | null }} Actor
 * @typedef {{
 *   actor: Actor | "system",
 *   workspaceId?: string | null,
 *   action: string,
 *   target?: string,
 *   result?: "ok" | "denied" | "error",
 *   meta?: Record<string, unknown>,
 *   ip?: string | null,
 * }} AuditEntry
 */

/**
 * @param {{
 *   store: { insertAudit: (row: object) => Promise<void>, memberEmail: (id: string) => Promise<string | null> },
 *   log: import("./log.mjs").Logger,
 *   now?: () => number,
 * }} opts
 */
export function createAudit({ store, log, now = Date.now }) {
  /** @type {Map<string, { email: string | null, at: number }>} */
  const emails = new Map();

  /** @param {string} userId */
  async function emailOf(userId) {
    const hit = emails.get(userId);
    if (hit && now() - hit.at < 10 * 60_000) return hit.email;
    let email = null;
    try {
      email = await store.memberEmail(userId);
    } catch {
      /* the event still gets written, without the email */
    }
    if (emails.size > 1_000) emails.clear();
    emails.set(userId, { email, at: now() });
    return email;
  }

  return {
    /** @param {AuditEntry} entry */
    async record(entry) {
      const system = entry.actor === "system";
      const actor = /** @type {Actor} */ (entry.actor);
      try {
        await store.insertAudit({
          actor_user_id: system ? null : actor.sub,
          actor_email: system ? "system" : await emailOf(actor.sub),
          workspace_id: entry.workspaceId ?? (system ? null : actor.wid),
          action: entry.action,
          target: entry.target ?? null,
          result: entry.result ?? "ok",
          ip: entry.ip ?? (system ? "internal" : null),
          meta: entry.meta ?? null,
        });
      } catch (e) {
        log.warn("audit write failed", { action: entry.action, error: e });
      }
    },
  };
}

/** @typedef {ReturnType<typeof createAudit>} Audit */
