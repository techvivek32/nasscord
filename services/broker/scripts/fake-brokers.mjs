import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { etDateKey } from "../src/time.mjs";
import { useFixedPorts } from "../test/helpers/common.mjs";
import { startFakeAlpaca } from "../test/helpers/fake-alpaca.mjs";
import { startFakeSchwab } from "../test/helpers/fake-schwab.mjs";
import { snapTimeText, startFakeSnapTrade } from "../test/helpers/fake-snaptrade.mjs";
import { CLIENT as TASTYTRADE_CLIENT, startFakeTastytrade } from "../test/helpers/fake-tastytrade.mjs";
import { startFakeTradeStation } from "../test/helpers/fake-tradestation.mjs";
import { CLIENT as TRADIER_CLIENT, startFakeTradier } from "../test/helpers/fake-tradier.mjs";
import { startFakeWebull } from "../test/helpers/fake-webull.mjs";

/**
 * Local fake brokers for every adapter package (Alpaca, Schwab, TradeStation, Tradier, tastytrade,
 * Webull and SnapTrade), seeded with one ready-to-connect login each. Developer use only: the fakes
 * hold sample data, and the broker service refuses BROKER_URL_OVERRIDES when NODE_ENV=production.
 *
 *   node scripts/fake-brokers.mjs [--port 9300]
 *
 * prints the broker service settings (BROKER_URL_OVERRIDES and the platform client credentials) and
 * the fake credentials to paste in the Connect dialogs, then runs until Ctrl+C. The fakes listen on
 * consecutive ports from --port, in a fixed order, so the printed .env stays valid across runs.
 *
 * The brokers send the browser back to http://localhost:3000/api/broker/callback/<broker> (the fakes
 * of Tradier, tastytrade and Webull have that callback registered), so run the app with `next dev`
 * on port 3000 and the broker service with OAUTH_CALLBACK_BASE=http://localhost:3000.
 *
 * IBKR and E*TRADE are not here: their fakes (test/helpers/fake-gateway.mjs, fake-etrade.mjs) are
 * wired in code by their own tests, not through BROKER_URL_OVERRIDES.
 *
 * test/e2e-all-brokers.test.mjs starts the same fakes on free ports (startFakeBrokers) and drives
 * every connect flow through the service's HTTP API.
 */

/** The canonical host the fakes send the browser back to. */
export const CALLBACK_BASE = "http://localhost:3000";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** @param {number} ms */
const iso = (ms) => new Date(ms).toISOString();

/**
 * @param {{ now?: () => number, basePort?: number }} [o]
 *   now: the clock every fake uses (a test's movable clock). basePort: listen on fixed ports from
 *   here (0 or unset: any free port).
 */
export async function startFakeBrokers(o = {}) {
  const now = o.now ?? Date.now;
  /** @type {Array<{ close: () => Promise<void> }>} */
  const started = [];
  const close = async () => {
    for (const f of started.reverse()) await f.close().catch(() => {});
  };
  useFixedPorts(o.basePort ?? 0);
  try {
    const t = now();

    // ── Alpaca: a Live margin account and a Paper account, each with its own key pair.
    const alpaca = await startFakeAlpaca();
    started.push(alpaca);
    alpaca.state.now = now;
    const alpacaLive = alpaca.addAccount({
      host: "live",
      accountNumber: "5AL00001",
      multiplier: "2",
      cash: "4200.50",
      equity: "25840.75",
      lastEquity: "25610.00",
      buyingPower: "40100.00",
      positions: [
        { asset_id: "a-aapl", symbol: "AAPL", asset_class: "us_equity", qty: "20", side: "long", avg_entry_price: "180.00", current_price: "190.00", market_value: "3800.00", unrealized_pl: "200.00", unrealized_intraday_pl: "12.00" },
        { asset_id: "a-spy", symbol: "SPY", asset_class: "us_equity", qty: "30", side: "long", avg_entry_price: "560.00", current_price: "590.00", market_value: "17700.00", unrealized_pl: "900.00", unrealized_intraday_pl: "-30.00" },
      ],
      orders: [
        { id: "al-ord-1", client_order_id: "c-1", symbol: "AAPL", asset_class: "us_equity", type: "limit", order_type: "limit", side: "buy", qty: "20", filled_qty: "20", filled_avg_price: "180.00", limit_price: "180.00", time_in_force: "day", status: "filled", submitted_at: iso(t - 2 * DAY), created_at: iso(t - 2 * DAY), legs: null },
        { id: "al-ord-2", client_order_id: "c-2", symbol: "MSFT", asset_class: "us_equity", type: "limit", order_type: "limit", side: "buy", qty: "5", filled_qty: "0", limit_price: "380.00", time_in_force: "gtc", status: "new", submitted_at: iso(t - 3 * 3_600_000), created_at: iso(t - 3 * 3_600_000), legs: null },
      ],
      fills: [
        { id: `${String(t - 2 * DAY).padStart(17, "0")}::al-fill-1`, activity_type: "FILL", transaction_time: iso(t - 2 * DAY), type: "fill", price: "180.00", qty: "20", side: "buy", symbol: "AAPL", leaves_qty: "0", order_id: "al-ord-1", cum_qty: "20", order_status: "filled" },
      ],
    });
    const alpacaPaper = alpaca.addAccount({ host: "paper", accountNumber: "PA5AL00002", equity: "100000.00", lastEquity: "100000.00", cash: "100000.00", buyingPower: "200000.00", multiplier: "2" });

    // ── Schwab: the owner's own Individual app with Nasscord's callback, the default login.
    const schwabApp = { key: "SchwabAppKeyQwErTyUiOpAsDfGhJkLz", secret: "SchwabSecret0123", callback: `${CALLBACK_BASE}/api/broker/callback/schwab` };
    const schwab = await startFakeSchwab({ now, apps: [schwabApp] });
    started.push(schwab);

    // ── TradeStation: a key with Nasscord's callback added, a Live margin account.
    const tradestation = await startFakeTradeStation({ now });
    started.push(tradestation);
    const tsKey = tradestation.addKey({ callbacks: [`${CALLBACK_BASE}/api/broker/callback/tradestation`] });
    const ts = tradestation.user("ts-user-1").live;
    ts.accounts = [{ AccountID: "11800001", AccountType: "Margin", Status: "Active", Currency: "USD" }];
    ts.balances = [{ AccountID: "11800001", Equity: "52000.00", CashBalance: "2000.00", BuyingPower: "100000.00", TodaysProfitLoss: "125.50" }];
    ts.positions = [
      { AccountID: "11800001", PositionID: "ts-p1", Symbol: "MSFT", AssetType: "STOCK", LongShort: "Long", Quantity: "100", AveragePrice: "400.00", Last: "410.00", MarketValue: "41000.00", UnrealizedProfitLoss: "1000.00", TodaysProfitLoss: "50.00" },
    ];
    const tsFilled = {
      AccountID: "11800001",
      OrderID: "ts-o1",
      OrderType: "Limit",
      Status: "FLL",
      Duration: "DAY",
      LimitPrice: "400.00",
      FilledPrice: "400.00",
      CommissionFee: "1.00",
      OpenedDateTime: iso(t - 2 * 3_600_000),
      ClosedDateTime: iso(t - 2 * 3_600_000 + MIN),
      Legs: [{ Symbol: "MSFT", AssetType: "STOCK", BuyOrSell: "Buy", QuantityOrdered: "100", ExecQuantity: "100", ExecutionPrice: "400.00" }],
    };
    ts.orders = [tsFilled];
    ts.history = [{ ...tsFilled }];

    // ── Tradier: Nasscord's partner client (OAuth) and the owner's personal token, the default login.
    const tradier = await startFakeTradier({ now });
    started.push(tradier);
    const tradierToken = tradier.addToken("live");

    // ── tastytrade: Nasscord's OAuth client, the default login.
    const tastytrade = await startFakeTastytrade({ now });
    started.push(tastytrade);

    // ── Webull Connect: Nasscord's app, the default login.
    const webull = await startFakeWebull({ now });
    started.push(webull);

    // ── SnapTrade: Nasscord's client; the portal "logs in" to one account of the chosen broker.
    const snapClientId = "NASSCORD-LOCAL";
    const snapConsumerKey = randomBytes(24).toString("base64url");
    const snaptrade = await startFakeSnapTrade({ clientId: snapClientId, consumerKey: snapConsumerKey });
    started.push(snaptrade);
    snaptrade.state.now = now;
    snaptrade.state.portal.accounts = (/** @type {any} */ auth) => [snaptradeAccount(auth.slug, now())];

    useFixedPorts(0);

    const overrides = {
      alpaca: alpaca.urls,
      schwab: { api: schwab.url },
      tradestation: tradestation.urls,
      tradier: tradier.urls,
      tastytrade: tastytrade.urls,
      webull: { api: webull.url },
      snaptrade: { api: snaptrade.url },
    };
    /** The broker service settings for these fakes (BROKER_AUDIENCE is left to the caller). */
    const env = Object.freeze({
      OAUTH_CALLBACK_BASE: CALLBACK_BASE,
      BROKER_URL_OVERRIDES: JSON.stringify(overrides),
      TRADIER_CLIENT_ID: TRADIER_CLIENT.id,
      TRADIER_CLIENT_SECRET: TRADIER_CLIENT.secret,
      TASTYTRADE_CLIENT_ID: TASTYTRADE_CLIENT.id,
      TASTYTRADE_CLIENT_SECRET: TASTYTRADE_CLIENT.secret,
      WEBULL_CLIENT_ID: webull.app.clientId,
      WEBULL_CLIENT_SECRET: webull.app.clientSecret,
      WEBULL_APP_KEY: webull.app.appKey,
      WEBULL_APP_SECRET: webull.app.appSecret,
      SNAPTRADE_CLIENT_ID: snapClientId,
      SNAPTRADE_CONSUMER_KEY: snapConsumerKey,
    });
    /** What a person pastes in the Connect dialogs. */
    const credentials = Object.freeze({
      alpaca: { live: { keyId: alpacaLive.keyId, secret: alpacaLive.secret }, paper: { keyId: alpacaPaper.keyId, secret: alpacaPaper.secret } },
      schwab: { appKey: schwabApp.key, appSecret: schwabApp.secret },
      tradestation: { clientId: tsKey.clientId, clientSecret: tsKey.clientSecret },
      tradier: { token: tradierToken },
    });
    return {
      fakes: { alpaca, schwab, tradestation, tradier, tastytrade, webull, snaptrade },
      accounts: { alpacaLive, alpacaPaper },
      overrides,
      env,
      credentials,
      close,
    };
  } catch (e) {
    useFixedPorts(0);
    await close();
    throw e;
  }
}

/**
 * One SnapTrade account of the broker the portal was opened for: cash, a stock, a filled order and
 * its trade.
 * @param {string} slug SnapTrade's brokerage slug ("FIDELITY")
 * @param {number} t
 */
function snaptradeAccount(slug, t) {
  const stock = (/** @type {string} */ ticker) => ({ id: `sym-${ticker}`, symbol: ticker, raw_symbol: ticker, description: `${ticker} Inc`, currency: { code: "USD" }, type: { code: "cs", description: "Common Stock" } });
  const name = slug.charAt(0) + slug.slice(1).toLowerCase();
  return {
    name: `${name} Individual`,
    number: `Z${slug.length}0012345`,
    rawType: "Margin",
    total: 18250.4,
    holdingsSync: snapTimeText(t - 6 * MIN),
    txThrough: etDateKey(t - 2 * DAY),
    balances: [{ currency: { id: "usd", code: "USD", name: "US Dollar" }, cash: 3250.4, buying_power: 6500.8 }],
    positions: [{ symbol: { symbol: stock("VTI"), id: "pos-vti", description: "VTI Inc" }, units: 50, price: 300, average_purchase_price: 280, open_pnl: 1000, currency: { code: "USD" } }],
    options: [],
    orders: [
      {
        brokerage_order_id: `${slug}-ord-1`,
        status: "EXECUTED",
        universal_symbol: stock("VTI"),
        option_symbol: null,
        action: "BUY",
        total_quantity: "10",
        open_quantity: "0",
        canceled_quantity: "0",
        filled_quantity: "10",
        execution_price: "295",
        limit_price: null,
        stop_price: null,
        order_type: "Market",
        time_in_force: "Day",
        time_placed: iso(t - 3 * DAY),
        time_updated: iso(t - 3 * DAY),
        time_executed: iso(t - 3 * DAY + MIN),
      },
    ],
    activities: [
      { id: `${slug}-act-1`, symbol: stock("VTI"), option_symbol: null, price: 295, units: 10, amount: -2950, fee: 0, type: "BUY", trade_date: `${etDateKey(t - 3 * DAY)}T00:00:00Z`, currency: { code: "USD" } },
    ],
  };
}

/** @param {string[]} argv */
function portArg(argv) {
  const i = argv.indexOf("--port");
  if (i === -1) return 9300;
  const n = Number(argv[i + 1]);
  if (!Number.isInteger(n) || n < 1024 || n > 65000) throw new Error("--port takes a port from 1024 to 65000");
  return n;
}

async function main() {
  const brokers = await startFakeBrokers({ basePort: portArg(process.argv.slice(2)) });
  const { fakes, env, credentials } = brokers;
  const out = [
    "Fake brokers are running (sample data, for development only). Ctrl+C stops them.",
    "",
    "Broker service settings (services/broker/.env; NODE_ENV must not be production):",
    ...Object.entries(env).map(([k, v]) => `${k}=${k === "BROKER_URL_OVERRIDES" ? `'${v}'` : v}`),
    "# Opens every connect method to every role, for a local click-through only:",
    "BROKER_AUDIENCE=all=all",
    "",
    "Paste in the Connect dialogs:",
    `  Alpaca Live      Key ID ${credentials.alpaca.live.keyId}  Secret ${credentials.alpaca.live.secret}`,
    `  Alpaca Paper     Key ID ${credentials.alpaca.paper.keyId}  Secret ${credentials.alpaca.paper.secret}`,
    `  Schwab app       App Key ${credentials.schwab.appKey}  Secret ${credentials.schwab.appSecret}`,
    `  TradeStation     API key ${credentials.tradestation.clientId}  Secret ${credentials.tradestation.clientSecret}`,
    `  Tradier token    ${credentials.tradier.token}`,
    "  tastytrade, Webull, Tradier OAuth and the SnapTrade brokers log in on the fake's page with no input.",
    "",
    "Hosts:",
    `  Alpaca        live ${fakes.alpaca.urls.live}  paper ${fakes.alpaca.urls.paper}`,
    `  Schwab        ${fakes.schwab.url}`,
    `  TradeStation  signin ${fakes.tradestation.urls.signin}  live ${fakes.tradestation.urls.live}  sim ${fakes.tradestation.urls.sim}`,
    `  Tradier       live ${fakes.tradier.urls.live}  sandbox ${fakes.tradier.urls.sandbox}`,
    `  tastytrade    ${fakes.tastytrade.url}`,
    `  Webull        ${fakes.webull.url}`,
    `  SnapTrade     ${fakes.snaptrade.url}`,
  ];
  process.stdout.write(`${out.join("\n")}\n`);
  const stop = () => {
    brokers.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    process.stderr.write(`fake brokers failed to start: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
