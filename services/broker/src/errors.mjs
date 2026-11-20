/**
 * Errors that carry an HTTP status and a sentence a user can read.
 * Anything thrown that is not an HttpError becomes a 500 with a generic sentence;
 * its own message is logged, never sent.
 */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message plain sentence for the user
   * @param {{ code?: string, cause?: unknown, retryAfterSec?: number }} [opts]
   */
  constructor(status, message, opts = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "HttpError";
    this.status = status;
    this.code = opts.code ?? "error";
    this.retryAfterSec = opts.retryAfterSec;
  }
}

/** @param {string} message */
export const badRequest = (message, code = "bad_request") => new HttpError(400, message, { code });
/** @param {string} message */
export const unauthorized = (message = "Sign in again to continue.", code = "unauthorized") =>
  new HttpError(401, message, { code });
/** @param {string} message */
export const forbidden = (message = "You do not have access to this.", code = "forbidden") =>
  new HttpError(403, message, { code });
/** @param {string} message */
export const notFound = (message = "Connection not found.", code = "not_found") => new HttpError(404, message, { code });
/** @param {string} message */
export const conflict = (message, code = "conflict") => new HttpError(409, message, { code });
/** @param {string} message */
export const unavailable = (message, code = "unavailable") => new HttpError(503, message, { code });
/**
 * @param {string} message
 * @param {string} [code]
 * @param {unknown} [cause]
 */
export const badGateway = (message, code = "broker_error", cause = undefined) =>
  new HttpError(502, message, { code, cause });
/**
 * @param {string} message
 * @param {number} [retryAfterSec]
 */
export const rateLimited = (message, retryAfterSec = 5) =>
  new HttpError(429, message, { code: "rate_limited", retryAfterSec });

/** @param {string} message */
export const gone = (message, code = "gone") => new HttpError(410, message, { code });

/**
 * What the user does to reconnect, answered by renew as `next.kind` (contract section 6).
 * @typedef {"gateway_login" | "oauth1_verifier" | "api_key" | "redirect"} ReauthKind
 */

/**
 * The broker says the session behind a connection is gone (E*TRADE 401 after a renew attempt,
 * IBKR not authenticated, an OAuth refresh answered invalid_grant). The caller marks the connection
 * expired. `reauth` says how the user reconnects, when the thrower knows.
 */
export class SessionExpiredError extends HttpError {
  /**
   * @param {string} message
   * @param {{ reauth?: ReauthKind }} [opts]
   */
  constructor(message, opts = {}) {
    super(409, message, { code: "session_expired" });
    this.name = "SessionExpiredError";
    /** @type {ReauthKind | null} */
    this.reauth = opts.reauth ?? null;
  }
}

/**
 * A broker answered 401 or 403 (createBrokerHttp). The adapter decides what it means: a
 * regenerated key, a revoked grant, or an expired token worth one refresh.
 */
export class BrokerAuthError extends HttpError {
  /**
   * @param {string} brokerName
   * @param {number} brokerStatus the broker's own status (401 or 403)
   */
  constructor(brokerName, brokerStatus) {
    super(409, `${brokerName} did not accept Nasscord's access. Reconnect to continue.`, { code: "broker_auth" });
    this.name = "BrokerAuthError";
    this.brokerStatus = brokerStatus;
  }
}

/**
 * A broker call outside an adapter's allowlist (createBrokerHttp, the IBKR gateway client, the
 * E*TRADE write transport). It is a bug, so it is never an HttpError: the user sees the generic 500
 * sentence and nothing reaches the broker.
 */
export class ReadOnlyViolation extends Error {
  /** @param {string} brokerName @param {string} method */
  constructor(brokerName, method) {
    super(`${brokerName}: a ${method} call outside the allowlist was blocked`);
    this.name = "ReadOnlyViolation";
  }
}

/** @param {unknown} err @returns {string} */
export function userMessage(err) {
  if (err instanceof HttpError) return err.message;
  return "Something went wrong on the broker service. Try again in a moment.";
}
