import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { SERVICE_ROOT } from "../src/config.mjs";
import { TEST_SECRET, TEST_TOKEN_KEY } from "./helpers/common.mjs";
import { freePorts } from "./helpers/fake-gateway.mjs";

/**
 * The real process: systemd runs it with Restart=on-failure, so a crash must exit non-zero (it is
 * restarted) and a stop (SIGINT, SIGTERM) must exit 0 (it stays stopped).
 */

const tmp = mkdtempSync(path.join(os.tmpdir(), "nasscord-exit-"));
after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

/**
 * @param {"crash" | "sigterm"} mode
 * @returns {Promise<{ code: number | null, out: string }>}
 */
async function run(mode) {
  const [apiPort, loginPort] = await freePorts(2);
  const child = spawn(
    process.execPath,
    ["--import", "./test/helpers/exit-after-start.mjs", "src/server.mjs"],
    {
      cwd: SERVICE_ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        SYSTEMROOT: process.env.SYSTEMROOT ?? "",
        NODE_ENV: "test",
        LOG_LEVEL: "info",
        API_PORT: String(apiPort),
        LOGIN_PORT: String(loginPort),
        SUPABASE_URL: "http://127.0.0.1:1",
        SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
        BROKER_SERVICE_SECRET: TEST_SECRET,
        BROKER_TOKEN_KEY: TEST_TOKEN_KEY,
        IBKR_GATEWAY_BUNDLE: path.join(tmp, "no-bundle"),
        IBKR_GATEWAY_RUNTIME: path.join(tmp, `runtime-${mode}`),
        TEST_EXIT_MODE: mode,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const code = await new Promise((resolve) => child.on("exit", (c) => resolve(c)));
  return { code: /** @type {number | null} */ (code), out };
}

test("an uncaught exception shuts down gracefully and exits 1, so systemd restarts the service", { timeout: 40_000 }, async () => {
  const { code, out } = await run("crash");
  assert.match(out, /"msg":"uncaught exception"/, out);
  assert.match(out, /"msg":"shutting down","reason":"uncaughtException"/);
  assert.match(out, /"msg":"stopped"/);
  assert.equal(code, 1);
});

test("SIGTERM shuts down gracefully and exits 0", { timeout: 40_000 }, async () => {
  const { code, out } = await run("sigterm");
  assert.match(out, /"msg":"shutting down","reason":"SIGTERM"/, out);
  assert.equal(code, 0);
});
