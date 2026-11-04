import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import { loadConfig } from "../../src/config.mjs";
import { signServiceJwt } from "../../src/jwt.mjs";

/** Throwaway secrets for tests, generated per run. */
export const TEST_SECRET = randomBytes(32).toString("base64url");
export const TEST_TOKEN_KEY = randomBytes(32).toString("base64");

/**
 * A valid config for tests (no real Supabase is called: tests pass an in-memory db).
 * @param {Record<string, string>} [env]
 */
export function testConfig(env = {}) {
  return loadConfig({
    NODE_ENV: "test",
    SUPABASE_URL: "http://127.0.0.1:1",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    BROKER_SERVICE_SECRET: TEST_SECRET,
    BROKER_TOKEN_KEY: TEST_TOKEN_KEY,
    LOG_LEVEL: "silent",
    ...env,
  });
}

/**
 * @param {{ sub?: string, wid?: string | null, role?: string, iat?: number, exp?: number, aud?: string, iss?: string }} [c]
 * @param {string} [secret]
 */
export function jwtFor(c = {}, secret = TEST_SECRET) {
  const iat = c.iat ?? Math.floor(Date.now() / 1000);
  return signServiceJwt(
    {
      iss: c.iss ?? "nasscord-app",
      aud: c.aud ?? "nasscord-broker",
      sub: c.sub ?? randomUUID(),
      wid: c.wid === undefined ? randomUUID() : c.wid,
      role: c.role ?? "trader",
      iat,
      exp: c.exp ?? iat + 60,
    },
    secret,
  );
}

/**
 * @param {http.RequestListener} handler
 * @returns {Promise<{ server: http.Server, port: number, url: string, close: () => Promise<void> }>}
 */
export async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r(undefined));
      }),
  };
}

/**
 * @param {string} url
 * @param {{ method?: string, token?: string, body?: unknown, headers?: Record<string, string> }} [o]
 */
export async function call(url, o = {}) {
  /** @type {Record<string, string>} */
  const headers = { ...(o.headers ?? {}) };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(url, {
    method: o.method ?? "GET",
    headers,
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
    redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text, headers: res.headers };
}

/** @param {number} ms */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
