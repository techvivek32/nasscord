import { createAdapter as alpaca } from "./alpaca/index.mjs";
import { createAdapter as schwab } from "./schwab/index.mjs";
import { createAdapter as snaptrade } from "./snaptrade/index.mjs";
import { createAdapter as tastytrade } from "./tastytrade/index.mjs";
import { createAdapter as tradestation } from "./tradestation/index.mjs";
import { createAdapter as tradier } from "./tradier/index.mjs";
import { createAdapter as webull } from "./webull/index.mjs";

/**
 * The one static list of broker packages (docs/real-backend.md, "Adapters"). Each folder owns its
 * index.mjs; this file does not change when a package lands. IBKR and E*TRADE are built in
 * server.mjs (they need the gateway manager and the OAuth 1.0a client) and registered next to these.
 *
 * The key is the folder name, which is also the key of BROKER_URL_OVERRIDES for that package.
 * @type {ReadonlyArray<[string, import("./adapter-types.mjs").AdapterFactory | null]>}
 */
export const BROKER_PACKAGES = Object.freeze([
  ["alpaca", alpaca],
  ["tradier", tradier],
  ["schwab", schwab],
  ["tastytrade", tastytrade],
  ["tradestation", tradestation],
  ["webull", webull],
  ["snaptrade", snaptrade],
]);
