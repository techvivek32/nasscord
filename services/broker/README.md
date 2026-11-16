# Nasscord broker service

A separate Node 24 process (zero npm dependencies) that holds everything broker-side for Nasscord:

- **IBKR**: one IBKR Client Portal Gateway JVM per connection, a public login host where the user logs in on
  IBKR's own page, a keepalive per gateway, and the reads (balances, positions, orders, executions, day P&L).
- **E\*TRADE**: OAuth 1.0a with the user's own consumer key (request token, authorize, verification code, access
  token), encrypted token storage, same-day renewal, revoke on disconnect, the midnight-Eastern expiry, and the reads.
- **Every other broker** through one adapter interface and a registry: Alpaca (the user's own API key), Tradier,
  Schwab, tastytrade, TradeStation and Webull (OAuth 2.0 through one canonical callback), and SnapTrade for Fidelity,
  Robinhood, Public, Moomoo, and Webull, Schwab and tastytrade until each approves Nasscord directly.
- The encryption key for `broker_secrets` and `broker_aggregator_users`, and every call to every broker. The Next app
  holds no broker secrets.

This first release is **read-only**: nothing here places, changes or cancels an order. IBKR and E\*TRADE call only
the read endpoints listed below. Every other adapter calls its broker through `http.mjs`, which refuses any method and
path that is not on that adapter's read allowlist (plus its token endpoint) before the request leaves the process.
Keys that can trade (an Alpaca key, a personal token) are therefore still used read-only, and each adapter has a test
that proves its allowlist.

The binding contract is [`docs/real-backend.md`](../../docs/real-backend.md) sections 5 to 11, and the schema is
[`supabase/migrations/20261103120000_init.sql`](../../supabase/migrations/20261103120000_init.sql) plus
[`supabase/migrations/20261116120000_more_brokers.sql`](../../supabase/migrations/20261116120000_more_brokers.sql).
The owner's steps for each broker (accounts, approvals, env vars, the order to switch things on) are in
[`docs/SETUP.md`](../../docs/SETUP.md), step 13.

**Run one instance only.** Locks (one change at a time per connection, one token refresh at a time), rate buckets,
the read cache, circuit breakers and the IBKR gateways live in this process's memory. Two instances would refresh a
rotating refresh token (Webull, TradeStation keys that rotate) twice and lose the connection.

```
src/
  server.mjs            both listeners, routing, graceful shutdown (stops every gateway JVM)
  config.mjs            environment, validated; names problems, never prints values; BROKER_AUDIENCE gate keys
  jwt.mjs               service JWT (HS256, node:crypto, timingSafeEqual)
  secrets.mjs           AES-256-GCM, 12-byte IV, AAD = connection id, key_version
  db.mjs                PostgREST over fetch with the service role, and the service's queries
  connections.mjs       workspace checks, audit, fan-out over connections through the registry
  registry.mjs          connect method -> adapter; validates descriptors at boot; GET /v1/options; the audience gate
  adapters.mjs          the one static list of broker packages (alpaca, tradier, schwab, tastytrade, tradestation,
                        webull, snaptrade)
  adapter-types.mjs     the adapter interface (JSDoc only): descriptor, reads, lifecycle, flow hooks
  http.mjs              createBrokerHttp: read allowlist, timeouts, rate buckets, 429 / "Quota Violation", no logging
  oauth2.mjs            the OAuth 2.0 engine: authorize URL (state, PKCE), code exchange, refresh under a lock,
                        rotated tokens saved before use, hard expiry, circuit breaker per broker and client
  flows.mjs             the generic connect steps: key connect, OAuth and SnapTrade start, hop, complete, claim,
                        duplicate merge by external_ref
  locks.mjs             one lock per connection, shared by the routes, the IBKR adapter, keepalive and scheduler
  limits.mjs            token buckets: IBKR 8/s per connection, E*TRADE 2/s per connection and module, a bucket per
                        adapter, global
  cache.mjs             per-connection read cache with in-flight dedupe; TTL per adapter (5 s to 30 min; SnapTrade
                        transactions up to a day)
  audit.mjs             audit_events rows
  mapping.mjs           IBKR and E*TRADE answers -> Nasscord shapes, and the shared helpers the other brokers use
  scheduler.mjs         midnight-ET expiry, login timeouts, slot release, abandoned hand-offs, adapter sweeps
  time.mjs              America/New_York helpers
  etrade/oauth1.mjs     RFC 5849 HMAC-SHA1 signing
  etrade/client.mjs     E*TRADE OAuth and signed reads
  etrade/adapter.mjs    start, verify, renew, disconnect, portfolio, orders, executions; registry shim
  ibkr/gateway-manager.mjs  slots, conf.yaml rendering, java spawn, health, stop
  ibkr/gateway-http.mjs     loopback calls to a gateway (fresh socket per call, GET retry on parse errors)
  ibkr/login-proxy.mjs      the public login host: ticket, cookie, allowlist, hardened reverse proxy
  ibkr/session.mjs          keepalive, first-login bootstrap, competing sessions
  ibkr/adapter.mjs          start, renew, disconnect, portfolio, orders, executions; registry shim
  alpaca/               index.mjs (adapter), client.mjs (allowlist, hosts), mapping.mjs
  tradier/              the same three files (personal token and partner OAuth)
  schwab/               the same three files
  tastytrade/           the same three files
  tradestation/         the same three files
  webull/               the same, plus signer.mjs (Webull's HMAC request signing)
  snaptrade/            the same, plus signer.mjs (request and webhook signatures), users.mjs (one SnapTrade
                        user per workspace) and webhook.mjs (POST /hooks/snaptrade)
```

A broker package exports `createAdapter(deps)` from its `index.mjs`, or `createAdapter = null` until it lands: the
registry then skips it and `GET /v1/options` answers its methods as `not_built`. A broker package edits only its own
folder; `adapters.mjs` does not change when one lands.

## API (API_PORT, default 8710)

JSON. Everything under `/v1` needs `Authorization: Bearer <service JWT>` (contract section 5: HS256 with
`BROKER_SERVICE_SECRET`, `iss` `nasscord-app`, `aud` `nasscord-broker`, 60 s life). Every connection id is checked
against the token's `wid`; a connection of another workspace answers 404. Errors are
`{ "error": "<sentence a user can read>", "code": "<machine code>" }`.

| Method and path | Body | Returns |
|---|---|---|
| `GET /health` | | `{ ok, version, uptimeSec }` (no auth; gateway counts are only in `/v1/health`) |
| `GET /v1/health` | | `{ connections: { <every broker id>: { <status>: count } }, adapters: [method], gateways }` (superadmin only) |
| `GET /v1/options` | | `{ callbackBase, options: ConnectOption[] }`: every way of connecting and whether this caller may use it now |
| `POST /v1/etrade/start` | `{ environment, consumerKey, consumerSecret }` | `{ connectionId, authorizeUrl }` |
| `POST /v1/etrade/verify` | `{ connectionId, verifier }` | `{ connection }` |
| `POST /v1/ibkr/start` | `{ environment }` (`production` or `paper`) | `{ connectionId, loginUrl }` |
| `POST /v1/ibkr/:id/ticket` | | `{ loginUrl }`, a fresh login link for the running gateway (400 E\*TRADE, 404 other workspace, 409 `no_gateway` / `disconnected`) |
| `POST /v1/keys/connect` | `{ brokerId, method?, environment?, keyId?, secret, connectionId? }` | `{ connection }` (api_key flow; `connectionId` re-keys that connection, 409 `other_account` for a key of another account) |
| `POST /v1/oauth/start` | `{ brokerId, method?, client?, environment?, clientId?, clientSecret?, returnOrigin, bindingHash }` | `{ connectionId }` |
| `POST /v1/aggregator/start` | `{ brokerId, environment?, returnOrigin, bindingHash }` | `{ connectionId }` |
| `POST /v1/connect/hop` | `{ connectionId, binding, repeat?, preview? }` | `{ redirectUrl, brokerId, workspaceName, requestedBy }` (canonical host; authorised by the binding nonce) |
| `POST /v1/oauth/complete` | `{ brokerId, state, code?, error?, bindings }` | `{ connectionId, returnOrigin, ticket }` (canonical callback; the code is exchanged here) |
| `POST /v1/aggregator/complete` | `{ connectionId, status, authorizationId?, binding }` | `{ connectionId, returnOrigin, ticket }` (SnapTrade's return on the canonical host) |
| `POST /v1/connect/claim` | `{ connectionId, ticket, binding }` | `{ connection }` (the user's own host; the caller must be the user who started) |
| `GET /v1/connections/:id` | | `{ connection }` (IBKR: checks the gateway first) |
| `POST /v1/connections/:id/renew` | `{ returnOrigin?, bindingHash? }` | `{ connection, next?, loginUrl? }` |
| `DELETE /v1/connections/:id` | | `{ ok: true }` |
| `GET /v1/portfolio` | | `{ accounts, positions, errors }` |
| `GET /v1/orders` | | `{ orders, errors }` |
| `GET /v1/executions` | | `{ executions, errors }` |
| `POST /hooks/<name>` | raw body, at most 64 KB | no service JWT: handed to the adapter of that method or broker (`/hooks/snaptrade`), which checks the broker's own signature; 404 when no adapter takes it |

`connection` is `{ id, brokerId, method, environment, status, statusDetail, sessionExpiresAt, lastOkAt, dataAsOf?,
scope?, accounts: [{ id, label, displayNumber, type, included }] }` with `status` as stored in the database.
`dataAsOf` (when SnapTrade last synced) and `scope` (the OAuth scope granted) are sent only when set; `external_ref`
(the broker-side name of the login) is never sent.

`next` from renew: `{ kind: "gateway_login" }` (IBKR), `{ kind: "oauth1_verifier", authorizeUrl }` (E\*TRADE),
`{ kind: "api_key" }` (paste the key again for the same connection), `{ kind: "redirect" }` (OAuth and SnapTrade: a
new login through the hop, which needs `returnOrigin` and `bindingHash` in the body). No `next`: the connection is
fine.
Only `included` accounts are read. One broker failing shows up in `errors` (`{ connectionId, message }`), not as a
failed request. On `/v1/portfolio` an IBKR account that cannot be read is left out and reported the same way
("IBKR account U12•••67: ..."), while the connection's other accounts are still answered.

Behaviour worth knowing on the app side:

- **IBKR start** reuses the workspace's existing IBKR connection of the same environment (pending, active, expired or
  error), its gateway and its account choices. After a disconnect it creates a new one.
- **IBKR renew**: still logged in, nothing to do (no `loginUrl`). Otherwise a login link for the running gateway, or a
  new gateway if the old one is gone; the connection goes back to `pending`.
- **Open the `loginUrl` right away** (a new tab on the click): its ticket lives 2 minutes. A late click shows "This
  login link has expired"; Reconnect gives a fresh link.
- Connect, Reconnect, Disconnect, a gateway restart by the keepalive and the scheduler's slot release all take the
  same per-connection lock, and the gateway manager runs at most one JVM per connection: two clicks, two tabs or a
  Reconnect during a release never start a second gateway.
- **Another IBKR username on Reconnect** (the advice after a competing session): the accounts of the earlier login
  are removed from the connection when the new login is first seen; the new login's accounts are added as included.
- **E\*TRADE renew**: same day and token alive, a silent `renew_access_token`. Otherwise (after midnight ET, revoked)
  a new request token with the stored consumer key: `loginUrl` is the E\*TRADE authorize page, and the user sends the
  new code to `POST /v1/etrade/verify` with the same `connectionId`.
- **E\*TRADE start** removes earlier attempts in the workspace (same environment) that never got past the code step.
- **Who may connect** is decided per method (and for Schwab and TradeStation per client), never per broker: the
  adapter must be built, configured (its env credentials, and `OAUTH_CALLBACK_BASE` for OAuth and SnapTrade), open to
  the caller under `BROKER_AUDIENCE`, and have an environment left once sample data is dropped in production. Every
  start, and every renew that starts a new login or asks for a new key, passes the same gate (403 `off` /
  `owner_only`). A plain refresh of an existing session stays open, so connections made before a gate closed keep
  reading. See "Who may connect" below.
- **One login, one connection.** Every login is named by `external_ref` (the Alpaca account id, the tastytrade
  customer id, Webull's identity_id, the SnapTrade authorization id, the TradeStation id_token `sub`, or for Schwab
  a hash of the App Key and the sorted account hashes, never the key itself). A login the workspace already has
  moves onto the existing connection, so its Included switches survive; a Reconnect that comes back with another
  login is refused (409 `other_account`).
- **The canonical-host hand-off** (OAuth and SnapTrade, contract section 8): start on the user's own host with a
  binding nonce kept in an HttpOnly cookie, a hop on the canonical host that proves the nonce and sets the same
  cookie there, the callback on the canonical host where the code is exchanged at once, and a claim on the user's
  own host with a one-time ticket. A code or a portal result never travels to a workspace or white-label host.
  Hand-off rows (`broker_oauth_pending`) keep only hashes and the return origin, work once and expire after 10
  minutes; the scheduler removes them.
- **Disconnect** revokes the E\*TRADE token or logs the IBKR gateway out and stops it, deletes the secret and the
  accounts, and leaves the connection row with status `disconnected`.
- **Limits on connect steps** (429 with `Retry-After`, the sentence in `error`): per user (`sub`), at most
  `BROKER_CONNECT_PER_USER` (20) starts and renews in 10 minutes, 20 E\*TRADE verifies and 60 login links; for the
  whole process, at most `BROKER_CONNECT_GLOBAL_PER_MIN` (60) new connections a minute, whatever the broker. Key
  connects, OAuth and SnapTrade starts count as starts; claims count as verifies. Refused attempts are not written to
  `audit_events` one by one.
- **Pending IBKR logins are capped**: at most `IBKR_MAX_PENDING_LOGINS` gateways (default half the slots) may wait
  for a login at one time; beyond that, start answers 503 `too_many_pending`. A connection that already has a gateway
  reuses it. A login not finished within its 20-minute window releases its slot at once.
- **Only terminal roles** (`superadmin`, `trader`, `tenant_user`) with a `wid` have connections. The app refuses
  every other role before calling, and the console will not turn a member with a connected broker into a tenant.
- **IBKR login links for the app**: the app does not open the `loginUrl` that start and renew return. Its route
  `GET /api/broker/ibkr/login/[id]` checks the Nasscord session and workspace, calls `POST /v1/ibkr/:id/ticket` for a
  link minted at that moment, and redirects to it. The ticket endpoint starts nothing; without a running gateway it
  answers 409 and the user presses Reconnect.
- `GET /v1/portfolio` positions: IBKR's position list has no per-position day P&L, so `dayPnl` is left out of IBKR
  positions (a gateway that sends `dailyPnl` gets it through); the account's day P&L (from `pnl/partitioned`) is on the
  account. E\*TRADE sends `daysGain` per position.
- `GET /v1/portfolio` accounts: a balance the broker did not report (no summary field, `pnl/partitioned` failed, no
  E\*TRADE portfolio totals) is left out of the account, never sent as 0.
- E\*TRADE executions are derived from filled orders (the contract's read set has no transactions call); commission is
  E\*TRADE's estimate, so they carry `provisional: true`.

## Who may connect (BROKER_AUDIENCE)

Each connect method has a gate key with an audience: `all` (every user with a trading workspace), `superadmin` (the
platform owner only) or `off`. Defaults (`AUDIENCE_DEFAULTS` in `config.mjs`):

| Gate key | Default | Why |
|---|---|---|
| `ibkr_gateway`, `etrade_oauth1`, `alpaca_key` | `all` | The user's own login or key, which each broker allows |
| `snaptrade` | `all` | Effective only once `SNAPTRADE_CLIENT_ID` and `SNAPTRADE_CONSUMER_KEY` are set, for the brokers in `SNAPTRADE_BROKERS`. Set `snaptrade=superadmin` while on SnapTrade's free Build plan |
| `schwab_oauth.user` | `superadmin` | Schwab defines an Individual app as your own app for your own account |
| `tradestation_oauth.user` | `superadmin` | A non-partner key only reaches its owner's accounts |
| `tradier_token` | `superadmin` | Tradier's API is for personal use unless you are a partner |
| `tastytrade_oauth` | `superadmin` | Until tastytrade verifies Nasscord the client is the owner's personal OAuth app |
| `alpaca_oauth`, `tradier_oauth`, `schwab_oauth.platform`, `tradestation_oauth.platform`, `webull_oauth` | `superadmin` | Platform clients: not configured until their env credentials exist, then the owner tests before opening them |

`BROKER_AUDIENCE=schwab_oauth.user=all,tradier_token=off` changes single keys; a bare `schwab_oauth=` or
`tradestation_oauth=` sets both clients; `all=<audience>` sets every key first (local testing only). An unknown key
or audience stops the service at boot (exit 78) with the key named. Restart the service after a change; the app
needs no redeploy, because it asks `GET /v1/options` (kept 60 s per role).

`GET /v1/options` answers one entry per method, client and broker: `{ brokerId, method, client, flow, environments,
audience, built, configured, available, reasonCode, reason, callbackUrl }`. `reasonCode` is `not_built`,
`not_configured`, `off`, `owner_only` or `no_environment`. For the super admin `reason` names the missing setting
("Not set up on this server: TRADIER_CLIENT_ID and TRADIER_CLIENT_SECRET are not set."); everyone else gets a
sentence without it. The console's Brokers page shows this answer, and the public pages say "Connect today" only for
a broker with a way open to everyone.

## Brokers

| Broker | Method (flow) | Environments | Session | Callback path |
|---|---|---|---|---|
| Interactive Brokers | `ibkr_gateway` (gateway login) | Live, Paper (the user's own) | about a day | none (login host) |
| E\*TRADE | `etrade_oauth1` (verification code) | Production; Sandbox for developers only | ends at midnight ET | none (code pasted back) |
| Alpaca | `alpaca_key` (API key); `alpaca_oauth` (Alpaca Connect, later) | Live, Paper (each paper account its own connection) | keys do not expire; a 401 asks for the new key | `/api/broker/callback/alpaca` |
| Tradier | `tradier_oauth` (partner); `tradier_token` (owner's personal token) | Live; Paper only by sandbox token with `TRADIER_SANDBOX_TOKENS` | 24 h without refresh tokens | `/api/broker/callback/tradier` |
| Charles Schwab | `schwab_oauth` (the user's own Individual app, or Nasscord's Commercial app later); `snaptrade` | Live only | a new login every 7 days, warned 48 h before | `/api/broker/callback/schwab` |
| tastytrade | `tastytrade_oauth`; `snaptrade` | Live; cert sandbox for developers only | until the grant is removed | `/api/broker/callback/tastytrade` |
| TradeStation | `tradestation_oauth` (the user's own key, or Nasscord's later) | Live; Paper (SIM) with `TRADESTATION_ALLOW_SIM` | no expiry, or 24 h when the key rotates refresh tokens | `/api/broker/callback/tradestation` |
| Webull | `webull_oauth` (Connect API); `snaptrade` until then | Live; Connect sandbox for developers only | 15-day refresh token, rotated | `/api/broker/callback/webull` |
| Fidelity, Robinhood, Public, Moomoo | `snaptrade` (SnapTrade's portal, read-only) | Live | SnapTrade's sync (`data_as_of`) | `/api/broker/callback/snaptrade` |

Every callback is `<OAUTH_CALLBACK_BASE>/api/broker/callback/<broker>` on the canonical host (`https://nasscord.com`),
never a workspace or tenant host. The exact read endpoints, read cache TTLs and rate buckets of each broker are in
its folder's `index.mjs` and `client.mjs` (the allowlist sits next to the hosts).

**Sample data never reaches users.** With `NODE_ENV=production` the service refuses every sandbox environment (E\*TRADE
sandbox keys, `TASTYTRADE_ENV=cert`, `WEBULL_ENV=sandbox`) and `BROKER_URL_OVERRIDES` outright, and a sandbox row left
from before is neither read nor renewed. The database keeps `sandbox` to E\*TRADE, tastytrade and Webull, and `paper` to
the user's own paper accounts (IBKR, Alpaca, a Tradier sandbox token, TradeStation SIM). SnapTrade's demo and sandbox
brokerages are refused by the adapter.

## Secrets

`broker_secrets` is AES-256-GCM with a random 12-byte IV, the connection id as AAD, base64 fields and `key_version`.
The plaintext is JSON, per method:

| Method | Plaintext |
|---|---|
| `etrade_oauth1` | `{ consumerKey, consumerSecret, requestToken?, requestSecret?, accessToken?, accessSecret? }` |
| `ibkr_gateway` | nothing: the session lives in the gateway process |
| `alpaca_key` | `{ keyId, secretKey, host: "live" \| "paper" }` |
| `tradier_token` | `{ token, host: "live" \| "sandbox" }` |
| `*_oauth` | `{ client: "user" \| "platform", clientId?, clientSecret?, redirectUri, accessToken?, accessExpiresAt?, refreshToken?, refreshIssuedAt?, refreshExpiresAt?, scope?, extra? }`. `clientId` and `clientSecret` only for the user's own app (Schwab, TradeStation); a platform client's credentials stay in this service's env. `extra` is the adapter's own (Schwab's account hash map). |
| `snaptrade` | no per-connection secret. The workspace's SnapTrade `userSecret` is in `broker_aggregator_users`, sealed with the same key and AAD `snaptrade:<workspace_id>`. |

A rotated refresh token is written to `broker_secrets` before the new access token is used. Disconnect deletes the
secret; expiry drops the tokens but keeps a user's own app key and secret, so Reconnect asks only for a new login.
Nothing here logs a key, secret, token, code, state, nonce, ticket, query string or response body: log lines carry
ids and statuses only.

## IBKR login host (LOGIN_PORT, default 8711, public as PUBLIC_LOGIN_URL)

1. `POST /v1/ibkr/start` starts a gateway on a free slot and answers `loginUrl = <PUBLIC_LOGIN_URL>/start?t=<ticket>`.
   The ticket is HMAC-SHA256 with `BROKER_SERVICE_SECRET` over `{ cid, exp, n }`, works once, and lives **2 minutes**.
2. `GET /start?t=` checks the ticket without using it and shows a confirmation page, before anything of IBKR loads:
   "The IBKR account you log in with there is connected to the Nasscord workspace **<name>**, at the request of
   **t•••@example.com**", the warning "If you did not press Connect in Nasscord just now, close this page.", and a
   **Continue to the IBKR login** button. No cookie is set yet.
3. The button posts the ticket to `POST /start`. Only a same-origin post is accepted (`Sec-Fetch-Site` must be
   `same-origin` when sent, `Origin` must match the host when sent; `Origin: null` is refused), so another site cannot
   press Continue for the visitor. The ticket is used, `nsibkr=<cid>.<exp>.<sig>` is set (HttpOnly, SameSite=Lax,
   Path=/, Secure on https, 1 hour) and the browser goes to `/` (303).

   Why: the login link is a bearer link. Whoever opens it gets IBKR's real login page, and the IBKR account that logs
   in there is attached to the workspace of the user who made the link. A trader could send their link to someone
   else ("connect your IBKR to Nasscord") and read that person's account. The confirmation names whose workspace it
   is, the 2-minute life narrows the window, and the same-origin check stops a silent auto-submit. It does not prove
   that the browser on the page is the Nasscord user who pressed Connect; see "Not done yet" below.
4. Every other request is routed by that cookie to the connection's gateway on `127.0.0.1:<slot>`, through this
   allowlist (found by loading the real gateway's login page on 2026-11-03):

   | Method | Path | What it is |
   |---|---|---|
   | GET | `/` | redirects to `/sso/Login?forwardTo=22&RL=1&ip2loc=US` |
   | GET, POST | `/sso/...` | `Login`, `lib/xyz.bundle.min.js`, `Authenticator`, `Dispatcher`, `report`, `ping` |
   | GET | `/css/...`, `/scripts/...`, `/images/...`, `/fonts/...`, `/stylesheet/...` | page assets |
   | POST | `/portal.proxy/v1/gstat/bulletins` | maintenance notice under the form |
   | GET | `/v1/api/iserver/auth/status` | login state |

   Everything else is refused and never reaches the gateway: a page navigation (GET, `Accept: text/html`) goes to the
   login host's own status page `/done`, anything else is a 403 (JSON for `/v1/api/...`). Paths with `..`, `//`,
   backslashes or encoded dots and slashes are refused. WebSocket upgrades are refused.
5. Proxy hardening, from NOVA's `server-proxy.cjs`: X-Forwarded-For, X-Real-IP, X-Forwarded-Host (and the other
   forwarding headers) are stripped, so the gateway sees the browser and the keepalive as one client; a fresh loopback
   connection per request; Set-Cookie made host-only (`Domain` dropped, `Path=/`, `SameSite=Lax`); absolute redirects
   to the gateway made relative; one retry of a GET on a parse error. Only `127.0.0.1` and only slot ports are ever
   proxied to. Once the gateway reports the login, `/` shows a "You are logged in" page (`/done`).

The keepalive (`session.mjs`) reads `GET /v1/api/iserver/auth/status` every 3 s while a login is pending and every
55 s after, with `POST /v1/api/tickle` every 55 s. On the first authenticated status it sends
`POST /iserver/auth/ssodh/init {"publish":true,"compete":false}`, reads `/iserver/accounts` and `/portfolio/accounts`,
upserts `broker_accounts` (and removes the connection's accounts that login does not list), and sets the connection
`active` for 24 hours. A `competing` session (TWS or the IBKR mobile app on the same username) is reported in
`status_detail`; **the service never sends `compete: true`**.

A watch belongs to one gateway (its port). When a gateway exits, only the watch of that gateway ends, so an old JVM
that finishes exiting after a Reconnect started a new one never cancels the new watch. A gateway that stops answering
for three cycles is replaced under the connection's lock; if a Reconnect came in meanwhile, the new gateway is watched
and the connection stays `pending`. `GET /v1/connections/:id` re-attaches a watch to a running gateway nobody polls.

### Gateway JVMs

- Command: `java -server -Xmx<IBKR_GATEWAY_XMX> ... -cp <runtime>/slot-<port>{sep}<bundle>/root{sep}<bundle>/dist/ibgroup.web.core.iblink.router.clientportal.gw.jar{sep}<bundle>/build/lib/runtime/* ibgroup.web.core.clientportal.gw.GatewayStart --conf conf.yaml`,
  working folder `<runtime>/slot-<port>`, `{sep}` = `path.delimiter`.
- **Why the slot folder is on the classpath:** the gateway loads `--conf` with `ClassLoader.getSystemResourceAsStream`,
  so it is a classpath resource name, not a file path. An absolute path fails with "Failed to load configuration
  file ... Stream closed". The slot folder goes first so its `conf.yaml` wins over the bundle's own `root/conf.yaml`.
- `conf.yaml` is rendered from `<bundle>/root/conf.yaml` with `listenPort: <slot>`, `listenSsl: false`,
  `ips.allow: [127.0.0.1]`, and without `sslCert` / `sslPwd`. The bundle's `vertx.jks` and its password are never
  copied.
- Slots are released on disconnect, when a login window ends without a login, 30 minutes after a logged-in session
  expired or errored, or when the JVM exits. A JVM that exits on its own, or is restarted because it stopped
  answering, ends the IBKR login (status `expired`).
- The JVM gets a minimal environment (`PATH`, `HOME`, `LANG`, `JAVA_HOME` and what Windows needs to start Java),
  never the service's secrets: it serves pages to browsers through the login host. It still runs as the service's
  user; for a harder boundary run it under its own uid.
- At most one JVM per connection: concurrent starts share one launch; a start waits for a gateway of the same
  connection that is still stopping to exit; one that never started listening is replaced. The scheduler releases by
  port, and re-checks under the connection's lock right before it stops a gateway. A released port is handed out again
  only after its slot folder is removed.
- On start the service marks IBKR connections of its previous run `expired` ("The broker service restarted...") and
  removes old slot folders.
- Memory: one gateway measured about 130 MB working set right after serving the login page (`-Xmx256m`). Budget about
  300 MB per logged-in gateway and size `IBKR_GATEWAY_PORTS` to the VPS's RAM (for example 20 slots on an 8 GB box).

## E\*TRADE

- `GET https://api.etrade.com/oauth/request_token` with `oauth_callback=oob`; the user opens
  `https://us.etrade.com/e/t/etws/authorize?key=<consumerKey>&token=<requestToken>` and pastes the code back;
  `GET /oauth/access_token` with `oauth_verifier`. The OAuth endpoints are on api.etrade.com for production and
  sandbox keys alike; reads go to `https://api.etrade.com` or `https://apisb.etrade.com`. Sandbox keys return
  E\*TRADE's sample accounts, so they are for developers only: refused whenever `NODE_ENV=production`.
- Stored encrypted in `broker_secrets`: `{ consumerKey, consumerSecret, requestToken?, requestSecret?, accessToken?, accessSecret? }`.
- `session_expires_at` is the next 00:00 America/New_York. At that minute the scheduler marks the connection
  `expired` with "E\*TRADE ends every session at midnight Eastern. Reconnect to continue." and drops the dead token
  (the consumer key stays, so reconnecting needs only a new code).
- A 401 on a read gets one same-day `renew_access_token` and one retry; an unused token is renewed after 90 minutes
  so E\*TRADE's 2-hour idle cut-off does not hit.
- An HTTP 400 with an HTML body is E\*TRADE's rate limiter: that bucket pauses (5 s, doubling to 60 s) and the read
  reports "E\*TRADE is limiting requests right now".
- Reads: `/v1/accounts/list`, `/v1/accounts/{accountIdKey}/balance?instType=BROKERAGE&realTimeNAV=true`,
  `/v1/accounts/{accountIdKey}/portfolio` (all pages, with totals for day P&L), `/v1/accounts/{accountIdKey}/orders`.

## Environment

| Name | Default | Purpose |
|---|---|---|
| `API_PORT`, `LOGIN_PORT` | 8710, 8711 | the two listeners |
| `API_HOST`, `LOGIN_HOST` | 127.0.0.1 | bind address (Caddy on the same host fronts both) |
| `PUBLIC_LOGIN_URL` | `http://localhost:<LOGIN_PORT>` | public origin of the login host; https required in production |
| `NASSCORD_APP_URL` | none | the app's URL, for the "Back to Nasscord" link on the login host pages (local `http://localhost:3000`) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | required | PostgREST with the service role (legacy JWT key or `sb_secret_` key) |
| `BROKER_SERVICE_SECRET` | required | same as the app; at least 32 bytes |
| `BROKER_TOKEN_KEY` | required | base64 of 32 random bytes (AES-256-GCM) |
| `BROKER_TOKEN_KEY_VERSION` | 1 | version written with new secrets |
| `BROKER_TOKEN_KEYS_PREVIOUS` | none | `1:<base64>,2:<base64>`: old keys still readable; rows are re-sealed on use |
| `IBKR_GATEWAY_BUNDLE` | `vendor/clientportal.gw` | the Client Portal Gateway folder (`dist/`, `build/lib/runtime/`, `root/`) |
| `IBKR_GATEWAY_RUNTIME` | `runtime` | writable folder for `slot-<port>/` |
| `IBKR_GATEWAY_PORTS` | `7200-7249` | slot range (`a-b` or a comma list) |
| `JAVA_BIN`, `IBKR_GATEWAY_XMX` | `java`, `256m` | the JVM |
| `ETRADE_ALLOW_SANDBOX` | `true` outside production | accept E\*TRADE sandbox keys (sample data); ignored in production, where they are always refused |
| `BROKER_GLOBAL_RPS` | 50 | process-wide broker calls per second |
| `BROKER_CONNECT_PER_USER` | 20 | connect starts plus renews per user in 10 minutes |
| `BROKER_CONNECT_GLOBAL_PER_MIN` | 60 | new connections per minute, whole process |
| `IBKR_MAX_PENDING_LOGINS` | half of `IBKR_GATEWAY_PORTS`, at least 2 | gateways waiting for a login at one time |
| `NODE_ENV` | development | `production` (the systemd unit sets it): https required for `PUBLIC_LOGIN_URL` and `OAUTH_CALLBACK_BASE`, every sample-data environment refused |
| `LOG_LEVEL` | info | debug, info, warn, error, silent |
| `OAUTH_CALLBACK_BASE` | `NASSCORD_APP_URL` or `http://localhost:3000` outside production; none in production | the canonical origin every broker returns to (`https://nasscord.com`); the app's `NEXT_PUBLIC_SITE_URL` must be the same. Without it OAuth and SnapTrade methods are "not configured". Frozen once registered |
| `BROKER_AUDIENCE` | see "Who may connect" | `key=all\|superadmin\|off`, comma-separated |
| `BROKER_URL_OVERRIDES` | none | JSON `{"<package>":{"<name>":"http://127.0.0.1:9001"}}` for local fake brokers; refused in production |
| `ALPACA_CLIENT_ID`, `ALPACA_CLIENT_SECRET` | none | Alpaca Connect (Nasscord's OAuth app) |
| `TRADIER_CLIENT_ID`, `TRADIER_CLIENT_SECRET` | none | Tradier partner OAuth client |
| `TRADIER_REFRESH_TOKENS` | false | `true` once Tradier enables refresh tokens for Nasscord |
| `TRADIER_SANDBOX_TOKENS` | false | `true` only after Tradier agrees in writing that users may paste their own sandbox (paper) token |
| `SCHWAB_CLIENT_ID`, `SCHWAB_CLIENT_SECRET` | none | Nasscord's Schwab Commercial app; a user's own Individual app needs nothing here |
| `TASTYTRADE_CLIENT_ID`, `TASTYTRADE_CLIENT_SECRET` | none | tastytrade OAuth client (the owner's personal app until verification) |
| `TASTYTRADE_ENV` | production | `cert` is sample data: developers only, refused in production |
| `TASTYTRADE_API_VERSION` | 20261012 | the `Accept-Version` header |
| `TRADESTATION_CLIENT_ID`, `TRADESTATION_CLIENT_SECRET` | none | Nasscord's own TradeStation key, once TradeStation accepts Nasscord as a partner |
| `TRADESTATION_ALLOW_SIM` | false | offer TradeStation Paper (SIM) once a real login confirms SIM shows only the user's own activity |
| `WEBULL_CLIENT_ID`, `WEBULL_CLIENT_SECRET`, `WEBULL_APP_KEY`, `WEBULL_APP_SECRET` | none | Webull Connect; the app key and secret only sign requests and are never sent |
| `WEBULL_ENV` | production | `sandbox` for Webull's required sandbox testing: developers only, refused in production |
| `SNAPTRADE_CLIENT_ID`, `SNAPTRADE_CONSUMER_KEY` | none | SnapTrade partner keys (the Build plan's keys connect real accounts too) |
| `SNAPTRADE_BROKERS` | `fidelity,robinhood,public,moomoo,webull` | brokers SnapTrade may connect: add `tastytrade` once production is approved, `schwab` once SnapTrade approves its Schwab profile, and leave `fidelity` out until its Fidelity profile is approved (docs/SETUP.md 13.4) |
| `SNAPTRADE_PLAN` | daily | `daily` or `realtime`, the SnapTrade plan you pay for: reads are kept 30 minutes on daily, 10 on realtime |

Every credential pair must be set together.

Relative paths are resolved from `services/broker`. A bad configuration exits with code 78 and a list of the
variables at fault (never their values). An uncaught exception stops every gateway and exits 1 (systemd restarts the
service); SIGTERM and SIGINT exit 0.

## Run it locally with the Next app

1. Java 17 (`java -version`) and the IBKR Client Portal Gateway bundle in `services/broker/vendor/clientportal.gw`
   (or point `IBKR_GATEWAY_BUNDLE` at it). Without the bundle E\*TRADE still works and IBKR answers 503.
2. `cp .env.example .env` in `services/broker`, fill in the Supabase project and two fresh secrets.
3. In the app's `.env.local`: `BROKER_SERVICE_URL=http://localhost:8710` and the same `BROKER_SERVICE_SECRET`.
4. `npm start` in `services/broker` (loads `.env`), then run the app as usual. The IBKR login opens on
   `http://localhost:8711`.

`npm test` runs every test with `node --test`, no network needed except the real-gateway test, which starts the
bundle's JVM and loads IBKR's login page through the login proxy (it never submits credentials). It is skipped when
Java or the bundle is missing, and reports a skip if IBKR's servers cannot be reached. `npm run typecheck` checks the
JSDoc types.

The other brokers are tested against local fakes in `test/helpers/` (`fake-oauth2.mjs` is a generic authorization
server; `fake-alpaca`, `fake-schwab`, `fake-tradestation`, `fake-tradier`, `fake-tastytrade`, `fake-webull` and
`fake-snaptrade` follow each broker's answers), with `harness.mjs` for the service plus a memory database
(`memory-db.mjs` enforces the same checks as the migration) and a fake clock. Per broker there is a flow test (connect,
reads, refresh, expiry, the read-only allowlist, nothing secret in a log line) and a mapping test.
`test/e2e-all-brokers.test.mjs` runs every package together in one service through the HTTP API: each connect flow
(keys, OAuth with the canonical-callback ticket, the SnapTrade portal), reads from every broker, the read-only
allowlists, the BROKER_AUDIENCE gate, Reconnect, Disconnect and the production refusals of sample data.

To click through the app against the fakes, `node scripts/fake-brokers.mjs [--port 9300]` starts all seven with
seeded logins on fixed ports and prints the service settings (`BROKER_URL_OVERRIDES`, the platform client
credentials, `OAUTH_CALLBACK_BASE=http://localhost:3000`, `BROKER_AUDIENCE=all=all`) and the fake keys to paste in the
Connect dialogs. Run the app with `next dev` on port 3000 (the fakes return the browser to
`http://localhost:3000/api/broker/callback/<broker>`). Development only, never on the VPS: the service refuses
`BROKER_URL_OVERRIDES` when `NODE_ENV=production`.

## Deploy on the VPS

A US VPS (the gateway's `ip2loc` is US), Ubuntu 24.04 or similar, with ports 80 and 443 open.

```sh
# software
sudo apt install -y openjdk-17-jre-headless caddy        # Node 24 from nodesource or the official tarball
sudo useradd --system --home /opt/nasscord-broker --shell /usr/sbin/nologin nasscord

# code and gateway bundle (read-only for the service)
sudo mkdir -p /opt/nasscord-broker && sudo rsync -a services/broker/ /opt/nasscord-broker/ --exclude .env --exclude runtime
sudo rsync -a <clientportal.gw bundle>/ /opt/nasscord-broker/vendor/clientportal.gw/
sudo chown -R root:nasscord /opt/nasscord-broker && sudo chmod -R o-rwx /opt/nasscord-broker

# configuration: KEY=value lines (see .env.example), production values
sudo install -m 600 -o root -g root /dev/null /etc/nasscord-broker.env
sudo nano /etc/nasscord-broker.env       # PUBLIC_LOGIN_URL=https://ibkr-login.<domain>, ETRADE_ALLOW_SANDBOX=false, ...

# service
sudo cp /opt/nasscord-broker/deploy/nasscord-broker.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now nasscord-broker
curl -s http://127.0.0.1:8710/health

# TLS (DNS A record for ibkr-login.<domain> first; broker.<domain> only when the app runs on another host).
# deploy/Caddyfile is a set of blocks: merge it, never copy it over a Caddyfile that already serves the app.
# Its global options block (the log filter) goes at the very top; add the site blocks yours lacks. On a fresh
# VPS: copy it, then uncomment the blocks for your layout (the header of the file says which).
sudo nano /etc/caddy/Caddyfile           # set NASSCORD_DOMAIN in Caddy's environment, or edit the names
sudo caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

Then point the app at the service: `BROKER_SERVICE_URL=http://127.0.0.1:8710` when the app runs on the same VPS (the
`broker.<domain>` block stays commented out), or `https://broker.<domain>` when it runs elsewhere. Logs:
`journalctl -u nasscord-broker -f` (JSON lines; secrets are redacted by key name before anything is written). The
unit uses `KillMode=control-group`, so stopping or restarting the service always stops every gateway JVM with it.
Run one instance only: gateway sessions, locks, buckets and token refreshes live in this process's memory.

**Deploy order** when a release changes the schema: the migration first (Supabase SQL Editor), then this service,
then the app. The service writes the new methods and tables; the app falls back to the old columns while the
migration is missing, but the order above is the supported one.

**More brokers on the VPS:** set `OAUTH_CALLBACK_BASE=https://nasscord.com` (the app's `NEXT_PUBLIC_SITE_URL`, the
same origin), each broker's credentials as its approval arrives, and `BROKER_AUDIENCE` if a default does not fit,
then `sudo systemctl restart nasscord-broker`. The console's Brokers page shows what each way of connecting still
misses. SnapTrade webhooks are optional: the commented `broker-hooks` block in `deploy/Caddyfile` publishes
`POST /hooks/snaptrade` and nothing else. Broker callbacks carry login codes in the query string, so keep them out
of Caddy's log twice over: add no `log` directive to a site block (Caddy writes no access log without one), and keep
the `log default` filter at the top of `/etc/caddy/Caddyfile`. Caddy's error log is always on and records the full
URI of a request that fails, such as a 502 while the app restarts; the filter cuts the query string off every logged
URI and drops the Referer header.

Back up `BROKER_TOKEN_KEY` somewhere other than the VPS: without it the stored broker keys, tokens and SnapTrade user
secrets cannot be read (users would connect again).

## Not done yet

- **Binding the IBKR login to the Nasscord user's browser.** The confirmation page, the 2-minute ticket and the
  same-origin Continue reduce the risk of a forwarded login link, but whoever holds a fresh link can still continue.
  The full fix needs the app: `/start` would redirect to an app route (for example
  `<NASSCORD_APP_URL>/api/broker/ibkr/confirm?c=<challenge>`) that checks the signed-in Nasscord session belongs to
  the user who started the connection and sends the browser back with a signed answer; only then is `nsibkr` set.
  That is a contract change (section 7) and an app route, outside this service.
- **Broker approvals.** The code for Schwab, TradeStation, Tradier, tastytrade, Webull and SnapTrade is in, gated by
  `BROKER_AUDIENCE` and by missing credentials until each broker (or SnapTrade) approves Nasscord in writing.
  `docs/SETUP.md` step 13 lists what is asked of whom.
- **Webull request signing.** Whether Webull Connect's resource calls (not only the token call) must be signed is not
  documented; the adapter has a TODO, to be settled with Webull during onboarding and its required sandbox testing.
- **Tradier consent text.** The consent the Tradier dialog shows is Nasscord's own wording until the partner
  agreement supplies Tradier's exhibit (`src/lib/broker-connect/tradier.ts`).
- **tastytrade token storage.** Ask tastytrade in writing how an approved integrator stores refresh tokens before
  opening `tastytrade_oauth` to everyone. A quote-streaming (DXLink) token is never shared across users.
- **SnapTrade `customRedirect`.** Whether SnapTrade needs the canonical callback host on an allowlist is not
  documented; check it in the dashboard when the production keys arrive.

