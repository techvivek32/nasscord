import assert from "node:assert/strict";
import { test } from "node:test";
import { AUDIENCE_DEFAULTS, ConfigError, gateKey, loadConfig } from "../src/config.mjs";
import { HttpError } from "../src/errors.mjs";
import { createRegistry, METHODS, validateAdapter } from "../src/registry.mjs";
import { BROKER_PACKAGES } from "../src/adapters.mjs";
import { TEST_SECRET, TEST_TOKEN_KEY, testConfig } from "./helpers/common.mjs";
import { BROKER_IDS, METHODS as DB_METHODS } from "./helpers/memory-db.mjs";

/** @param {Partial<import("../src/adapter-types.mjs").AdapterDescriptor>} d @param {Record<string, unknown>} [fns] */
const adapter = (d, fns = {}) =>
  /** @type {any} */ ({
    descriptor: {
      method: "alpaca_key",
      brokers: ["alpaca"],
      name: "Alpaca",
      environments: ["production", "paper"],
      readTtlMs: { portfolio: 1, orders: 1, executions: 1 },
      ...d,
    },
    orders: async () => [],
    executions: async () => [],
    portfolio: async () => ({ accounts: [], positions: [] }),
    connectKey: async () => ({}),
    ...fns,
  });

const prodEnv = {
  NODE_ENV: "production",
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  BROKER_SERVICE_SECRET: TEST_SECRET,
  BROKER_TOKEN_KEY: TEST_TOKEN_KEY,
  PUBLIC_LOGIN_URL: "https://ibkr-login.example.com",
  OAUTH_CALLBACK_BASE: "https://nasscord.com",
};

const trader = /** @type {any} */ ({ sub: "u", wid: "w", role: "trader" });
const owner = /** @type {any} */ ({ sub: "u", wid: "w", role: "superadmin" });

test("the service knows exactly the methods and brokers of the migration", () => {
  assert.deepEqual(Object.keys(METHODS).sort(), DB_METHODS.filter((m) => m !== "ibkr_oauth").sort());
  const brokers = new Set(Object.values(METHODS).flatMap((m) => m.brokers));
  assert.deepEqual([...brokers].sort(), [...BROKER_IDS].sort());
  assert.deepEqual(
    BROKER_PACKAGES.map(([name]) => name),
    ["alpaca", "tradier", "schwab", "tastytrade", "tradestation", "webull", "snaptrade"],
  );
});

test("descriptors are checked at boot", () => {
  assert.doesNotThrow(() => validateAdapter(adapter({})));
  assert.throws(() => validateAdapter(adapter({ method: /** @type {any} */ ("made_up") })), /method the database does not know/);
  assert.throws(() => validateAdapter(adapter({ brokers: ["schwab"] })), /broker its method cannot serve/);
  assert.throws(() => validateAdapter(adapter({ environments: ["sandbox"] })), /environment its method cannot offer/);
  assert.throws(() => validateAdapter(adapter({ readTtlMs: /** @type {any} */ ({ portfolio: 1 }) })), /readTtlMs/);
  assert.throws(() => validateAdapter(adapter({ sweepEveryMs: 10 })), /sweepEveryMs/);
  assert.throws(() => validateAdapter(adapter({}, { connectKey: undefined })), /connectKey/);
  assert.throws(() => validateAdapter(adapter({}, { portfolio: undefined })), /portfolio\(\), or balances\(\) and positions\(\)/);
  assert.throws(
    () => validateAdapter(adapter({ method: "schwab_oauth", brokers: ["schwab"], environments: ["production"] })),
    /needs oauthProfile\(\) and identify\(\)/,
  );
  assert.throws(
    () => validateAdapter(adapter({ method: "snaptrade", brokers: ["fidelity"], environments: ["production"] })),
    /portalUrl\(\) and aggregatorComplete\(\)/,
  );
  assert.throws(() => createRegistry([adapter({}), adapter({})], testConfig()), /registered twice/);
});

test("a trading part: only the three trading methods, with every order function", () => {
  const fn = async () => ({});
  const trading = { capabilities: () => null, previewOrder: fn, positionState: fn, placeOrder: fn, reconcileOrder: fn, cancelOrder: fn };
  assert.doesNotThrow(() => validateAdapter(adapter({}, { trading })));
  assert.throws(
    () => validateAdapter(adapter({ method: "alpaca_oauth", environments: ["production"] }, { oauthProfile: () => ({}), identify: fn, trading })),
    /may not trade: only ibkr_gateway, etrade_oauth1 and alpaca_key have a trading part/,
  );
  assert.throws(
    () => validateAdapter(adapter({ method: "tradier_token", brokers: ["tradier"], environments: ["production"] }, { trading })),
    /may not trade/,
  );
  for (const name of ["capabilities", "previewOrder", "positionState", "placeOrder", "reconcileOrder", "cancelOrder"]) {
    assert.throws(() => validateAdapter(adapter({}, { trading: { ...trading, [name]: undefined } })), new RegExp(`trading needs ${name}\\(\\)`), name);
  }
  assert.throws(() => validateAdapter(adapter({}, { trading: null })), /trading needs/);
  assert.throws(() => createRegistry([adapter({ method: "tradier_token", brokers: ["tradier"], environments: ["production"] }, { trading })], testConfig()), /may not trade/);

  const reg = createRegistry([adapter({}, { trading })], testConfig());
  assert.equal(reg.tradingFor({ method: "alpaca_key" }), trading);
  assert.equal(reg.tradingFor({ method: "alpaca_oauth" }), null);
  assert.equal(reg.tradingFor({ method: "ibkr_oauth" }), null);
  assert.equal(createRegistry([adapter({})], testConfig()).tradingFor({ method: "alpaca_key" }), null);
});

test("order entry config: defaults, limits and warnings", () => {
  const c = testConfig();
  assert.deepEqual({ ...c.orders }, { entry: "on", maxQty: 10_000, maxNotional: 250_000, ibkrStopOrders: "paper", ibkrBrackets: "paper", etradeBody: "xml" });
  assert.ok(Object.isFrozen(c.orders));
  const off = testConfig({ ORDER_ENTRY: "off", IBKR_BRACKETS: "on" });
  assert.ok(off.warnings.includes("ORDER_ENTRY=off: every preview and place is refused"));
  assert.ok(off.warnings.includes("IBKR_BRACKETS=on needs IBKR_STOP_ORDERS=on: live IBKR accounts get no brackets until both are on"));
  assert.throws(() => testConfig({ ORDER_MAX_QTY: "0" }), (e) => e instanceof ConfigError && e.problems.includes("ORDER_MAX_QTY must be a whole number from 1 to 1000000"));
  assert.throws(() => testConfig({ ORDER_MAX_NOTIONAL: "999" }), /ORDER_MAX_NOTIONAL must be a whole number from 1000 to 100000000/);
  assert.throws(() => testConfig({ ORDER_ENTRY: "maybe" }), /ORDER_ENTRY must be one of on, off/);
  assert.throws(() => testConfig({ IBKR_STOP_ORDERS: "yes" }), /IBKR_STOP_ORDERS must be one of off, paper, on/);
  assert.throws(() => testConfig({ ETRADE_ORDER_BODY: "form" }), /ETRADE_ORDER_BODY must be one of xml, json/);
  assert.equal(testConfig({ ETRADE_ORDER_BODY: "json", IBKR_STOP_ORDERS: "on" }).orders.etradeBody, "json");
});

test("BROKER_AUDIENCE: per method and client, with the binding defaults", () => {
  const c = testConfig();
  assert.equal(c.audience.ibkr_gateway, "all");
  assert.equal(c.audience.etrade_oauth1, "all");
  assert.equal(c.audience.alpaca_key, "all");
  assert.equal(c.audience.snaptrade, "all");
  assert.equal(c.audience["schwab_oauth.user"], "superadmin");
  assert.equal(c.audience["tradestation_oauth.user"], "superadmin");
  assert.equal(c.audience.tradier_token, "superadmin");
  assert.equal(c.audience.tastytrade_oauth, "superadmin");
  assert.equal(gateKey("schwab_oauth", "platform"), "schwab_oauth.platform");
  assert.equal(gateKey("alpaca_key"), "alpaca_key");

  const a = testConfig({ BROKER_AUDIENCE: "schwab_oauth=all, tradier_token=off, tradestation_oauth.platform=all" });
  assert.equal(a.audience["schwab_oauth.user"], "all", "a bare two-client method sets both clients");
  assert.equal(a.audience["schwab_oauth.platform"], "all");
  assert.equal(a.audience.tradier_token, "off");
  assert.equal(a.audience["tradestation_oauth.user"], "superadmin");
  assert.equal(a.audience["tradestation_oauth.platform"], "all");

  const all = testConfig({ BROKER_AUDIENCE: "tradier_token=off,all=all" });
  for (const k of Object.keys(AUDIENCE_DEFAULTS)) if (k !== "tradier_token") assert.equal(all.audience[k], "all", k);
  assert.equal(all.audience.tradier_token, "off", "a specific key wins over all=");

  assert.throws(() => testConfig({ BROKER_AUDIENCE: "robinhood_password=all" }), /robinhood_password is not a connect method/);
  assert.equal(testConfig({ BROKER_AUDIENCE: "etrade_oauth1=off" }).audience.etrade_oauth1, "off");
  assert.throws(() => testConfig({ BROKER_AUDIENCE: "alpaca_key=everyone" }), /must be all, superadmin or off/);
});

test("config: sample-data environments and fake hosts are refused in production; values never echoed", () => {
  assert.doesNotThrow(() => loadConfig(prodEnv));
  for (const [env, why] of /** @type {const} */ ([
    [{ TASTYTRADE_ENV: "cert" }, /TASTYTRADE_ENV=cert is sample data/],
    [{ WEBULL_ENV: "sandbox" }, /WEBULL_ENV=sandbox is sample data/],
    [{ BROKER_URL_OVERRIDES: '{"alpaca":{"live":"http://127.0.0.1:9"}}' }, /BROKER_URL_OVERRIDES .* refused in production/],
    [{ OAUTH_CALLBACK_BASE: "http://nasscord.com" }, /OAUTH_CALLBACK_BASE must use https in production/],
    [{ OAUTH_CALLBACK_BASE: "https://nasscord.com/app" }, /must be an origin with no path/],
  ])) {
    assert.throws(() => loadConfig({ ...prodEnv, ...env }), why);
  }
  const warned = loadConfig({ ...prodEnv, ETRADE_ALLOW_SANDBOX: "true" });
  assert.equal(warned.etrade.allowSandbox, false, "E*TRADE sandbox keys are never accepted in production");
  assert.match(warned.warnings.join("\n"), /ETRADE_ALLOW_SANDBOX is ignored in production/);

  try {
    testConfig({ TRADIER_CLIENT_ID: "tradier-id-value-123", SNAPTRADE_CONSUMER_KEY: "snap-secret-value-456", SNAPTRADE_BROKERS: "fidelity,vanguard" });
    assert.fail("should throw");
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    assert.match(e.message, /TRADIER_CLIENT_ID and TRADIER_CLIENT_SECRET must be set together/);
    assert.match(e.message, /SNAPTRADE_CLIENT_ID and SNAPTRADE_CONSUMER_KEY must be set together/);
    assert.match(e.message, /SNAPTRADE_BROKERS must list only/);
    assert.ok(!e.message.includes("tradier-id-value-123") && !e.message.includes("snap-secret-value-456"));
  }

  const dev = testConfig({ BROKER_URL_OVERRIDES: '{"alpaca":{"live":"http://127.0.0.1:9001/"}}' });
  assert.deepEqual(dev.urlOverrides, { alpaca: { live: "http://127.0.0.1:9001" } });
  assert.equal(dev.oauth.callbackBase, "http://localhost:3000", "outside production the local app is the default");
  assert.equal(loadConfig({ ...prodEnv, OAUTH_CALLBACK_BASE: "" }).oauth.callbackBase, null, "no default in production");
  assert.deepEqual(dev.brokers.snaptrade.brokers, ["fidelity", "robinhood", "public", "moomoo", "webull"]);
  assert.equal(dev.brokers.snaptrade.plan, "daily");
  assert.equal(dev.brokers.tastytrade.apiVersion, "20261012");
});

test("options: built, configured, audience and environment per method and client", () => {
  const cfg = testConfig();
  const reg = createRegistry(
    [
      adapter({}),
      adapter(
        { method: "schwab_oauth", brokers: ["schwab"], environments: ["production"], clients: ["user"] },
        { connectKey: undefined, oauthProfile: () => ({}), identify: async () => ({}) },
      ),
    ],
    cfg,
  );
  const forTrader = reg.options(trader);
  assert.equal(forTrader.callbackBase, "http://localhost:3000");
  /** @param {any} o @param {string} b @param {string} m @param {string | null} [c] */
  const pick = (o, b, m, c = null) => o.options.find((x) => x.brokerId === b && x.method === m && x.client === c);

  const alpaca = pick(forTrader, "alpaca", "alpaca_key");
  assert.deepEqual(
    { available: alpaca.available, flow: alpaca.flow, environments: alpaca.environments, callbackUrl: alpaca.callbackUrl },
    { available: true, flow: "api_key", environments: ["production", "paper"], callbackUrl: null },
  );

  const schwabUser = pick(forTrader, "schwab", "schwab_oauth", "user");
  assert.equal(schwabUser.available, false);
  assert.equal(schwabUser.reasonCode, "owner_only", "the per-user Schwab app is the owner's own testing until Schwab agrees");
  assert.equal(schwabUser.callbackUrl, "http://localhost:3000/api/broker/callback/schwab");
  assert.equal(pick(reg.options(owner), "schwab", "schwab_oauth", "user").available, true);

  const schwabPlatform = pick(reg.options(owner), "schwab", "schwab_oauth", "platform");
  assert.equal(schwabPlatform.reasonCode, "not_built", "this adapter only takes the user's own app");

  const tradier = pick(forTrader, "tradier", "tradier_token");
  assert.equal(tradier.reasonCode, "not_built");
  const fidelity = pick(forTrader, "fidelity", "snaptrade");
  assert.equal(fidelity.flow, "aggregator_portal");
  assert.equal(fidelity.callbackUrl, "http://localhost:3000/api/broker/callback/snaptrade");

  // Every broker of the registry has at least one entry.
  for (const b of BROKER_IDS) assert.ok(forTrader.options.some((x) => x.brokerId === b), b);
});

test("options: platform clients and SnapTrade need their env credentials; sandbox is dropped in production", () => {
  const base = { env: {} };
  void base;
  const snap = adapter(
    { method: "snaptrade", brokers: ["fidelity", "robinhood", "public", "moomoo", "webull"], environments: ["production"] },
    { connectKey: undefined, portalUrl: async () => "", aggregatorComplete: async () => ({}) },
  );
  const tasty = adapter(
    { method: "tastytrade_oauth", brokers: ["tastytrade"], environments: ["production", "sandbox"], clients: ["platform"] },
    { connectKey: undefined, oauthProfile: () => ({}), identify: async () => ({}) },
  );
  const without = createRegistry([snap, tasty], testConfig());
  const o1 = without.options(owner);
  const f1 = o1.options.find((x) => x.brokerId === "fidelity");
  assert.equal(f1?.reasonCode, "not_configured");
  assert.match(String(f1?.reason), /SNAPTRADE_CLIENT_ID and SNAPTRADE_CONSUMER_KEY are not set/, "the owner sees what to set");
  const f1t = without.options(trader).options.find((x) => x.brokerId === "fidelity");
  assert.equal(f1t?.reason, "Fidelity is not set up on this server yet.", "a trader sees a plain sentence");
  assert.equal(o1.options.find((x) => x.method === "tastytrade_oauth")?.reasonCode, "not_configured");

  const withKeys = createRegistry(
    [snap, tasty],
    testConfig({
      SNAPTRADE_CLIENT_ID: "snap-id",
      SNAPTRADE_CONSUMER_KEY: "snap-key",
      SNAPTRADE_BROKERS: "fidelity,robinhood",
      TASTYTRADE_CLIENT_ID: "tt-id",
      TASTYTRADE_CLIENT_SECRET: "tt-secret",
    }),
  );
  const o2 = withKeys.options(trader);
  assert.equal(o2.options.find((x) => x.brokerId === "fidelity")?.available, true, "snaptrade=all once its keys are set");
  assert.equal(o2.options.find((x) => x.brokerId === "moomoo" && x.method === "snaptrade")?.reasonCode, "not_configured", "not in SNAPTRADE_BROKERS");
  assert.equal(o2.options.find((x) => x.method === "tastytrade_oauth")?.reasonCode, "owner_only", "the tastytrade personal app is the owner's");
  assert.deepEqual(withKeys.options(owner).options.find((x) => x.method === "tastytrade_oauth")?.environments, ["production", "sandbox"]);

  const prod = createRegistry([tasty], loadConfig({ ...prodEnv, TASTYTRADE_CLIENT_ID: "tt-id", TASTYTRADE_CLIENT_SECRET: "tt-secret" }));
  assert.deepEqual(prod.options(owner).options.find((x) => x.method === "tastytrade_oauth")?.environments, ["production"], "no sample data in production");
});

test("gate: 403 for the audience, 503 for what is not built or set up; audienceOnly for IBKR and E*TRADE", () => {
  const reg = createRegistry([adapter({})], testConfig({ BROKER_AUDIENCE: "etrade_oauth1=off" }));
  assert.equal(reg.gate(trader, "alpaca", "alpaca_key", null).available, true);
  assert.throws(
    () => reg.gate(trader, "tradier", "tradier_token", null),
    (e) => e instanceof HttpError && e.status === 503 && e.code === "not_built",
  );
  assert.throws(
    () => reg.gate(trader, "alpaca", "schwab_oauth", "user"),
    (e) => e instanceof HttpError && e.status === 400 && e.code === "unknown_method",
  );
  assert.throws(
    () => reg.gate(trader, "etrade", "etrade_oauth1", null, { audienceOnly: true }),
    (e) => e instanceof HttpError && e.status === 403 && e.code === "off",
  );
  // IBKR is not registered here: with audienceOnly the setup problem is left to its own route.
  assert.equal(reg.gate(trader, "ibkr", "ibkr_gateway", null, { audienceOnly: true }).reasonCode, "not_built");
  assert.throws(() => reg.adapterFor({ method: "webull_oauth", broker_id: "webull" }), /cannot read Webull connections/);
});
