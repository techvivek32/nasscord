# Nasscord broker service

A separate Node 24 process (zero npm dependencies) that holds everything broker-side for Nasscord:

- **IBKR**: one IBKR Client Portal Gateway JVM per connection, a public login host where the user logs in on
  IBKR's own page, a keepalive per gateway, and the reads (balances, positions, orders, executions, day P&L).
- **E\*TRADE**: OAuth 1.0a with the user's own consumer key (request token, authorize, verification code, access
  token), encrypted token storage, same-day renewal, revoke on disconnect, the midnight-Eastern expiry, and the reads.
- The encryption key for `broker_secrets` and every call to IBKR and E\*TRADE. The Next app holds no broker secrets.

This first release is **read-only**: nothing here places, changes or cancels an order.

The binding contract is [`docs/real-backend.md`](../../docs/real-backend.md) sections 5 to 8, and the schema is
[`supabase/migrations/20261103120000_init.sql`](../../supabase/migrations/20261103120000_init.sql).

```
src/
  server.mjs            both listeners, routing, graceful shutdown (stops every gateway JVM)
  config.mjs            environment, validated; names problems, never prints values
  jwt.mjs               service JWT (HS256, node:crypto, timingSafeEqual)
  secrets.mjs           AES-256-GCM, 12-byte IV, AAD = connection id, key_version
  db.mjs                PostgREST over fetch with the service role, and the service's queries
  connections.mjs       workspace checks, audit, fan-out over connections
  locks.mjs             one lock per connection, shared by the routes, the IBKR adapter, keepalive and scheduler
  limits.mjs            token buckets: IBKR 8/s per connection, E*TRADE 2/s per connection and module, global
  cache.mjs             5 s per-connection cache with in-flight dedupe
  audit.mjs             audit_events rows
  mapping.mjs           broker answers -> Nasscord Position / Order / Execution / account shapes
  scheduler.mjs         midnight-ET expiry, login timeouts, slot release
  time.mjs              America/New_York helpers
  etrade/oauth1.mjs     RFC 5849 HMAC-SHA1 signing
  etrade/client.mjs     E*TRADE OAuth and signed reads
  etrade/adapter.mjs    start, verify, renew, disconnect, portfolio, orders, executions
  ibkr/gateway-manager.mjs  slots, conf.yaml rendering, java spawn, health, stop
  ibkr/gateway-http.mjs     loopback calls to a gateway (fresh socket per call, GET retry on parse errors)
  ibkr/login-proxy.mjs      the public login host: ticket, cookie, allowlist, hardened reverse proxy
  ibkr/session.mjs          keepalive, first-login bootstrap, competing sessions
  ibkr/adapter.mjs          start, renew, disconnect, portfolio, orders, executions
```

## API (API_PORT, default 8710)

JSON. Everything under `/v1` needs `Authorization: Bearer <service JWT>` (contract section 5: HS256 with
`BROKER_SERVICE_SECRET`, `iss` `nasscord-app`, `aud` `nasscord-broker`, 60 s life). Every connection id is checked
against the token's `wid`; a connection of another workspace answers 404. Errors are
`{ "error": "<sentence a user can read>", "code": "<machine code>" }`.

| Method and path | Body | Returns |
|---|---|---|
| `GET /health` | | `{ ok, version, uptimeSec }` (no auth; gateway counts are only in `/v1/health`) |
| `GET /v1/health` | | connection counts by broker and status, gateway slots (superadmin only) |
| `POST /v1/etrade/start` | `{ environment, consumerKey, consumerSecret }` | `{ connectionId, authorizeUrl }` |
| `POST /v1/etrade/verify` | `{ connectionId, verifier }` | `{ connection }` |
| `POST /v1/ibkr/start` | `{ environment }` (`production` or `paper`) | `{ connectionId, loginUrl }` |
| `POST /v1/ibkr/:id/ticket` | | `{ loginUrl }`, a fresh login link for the running gateway (400 E\*TRADE, 404 other workspace, 409 `no_gateway` / `disconnected`) |
| `GET /v1/connections/:id` | | `{ connection }` (IBKR: checks the gateway first) |
| `POST /v1/connections/:id/renew` | | `{ connection, loginUrl? }` |
| `DELETE /v1/connections/:id` | | `{ ok: true }` |
| `GET /v1/portfolio` | | `{ accounts, positions, errors }` |
| `GET /v1/orders` | | `{ orders, errors }` |
| `GET /v1/executions` | | `{ executions, errors }` |

`connection` is `{ id, brokerId, method, environment, status, statusDetail, sessionExpiresAt, lastOkAt,
accounts: [{ id, label, displayNumber, type, included }] }` with `status` as stored in the database.
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
- **Disconnect** revokes the E\*TRADE token or logs the IBKR gateway out and stops it, deletes the secret and the
  accounts, and leaves the connection row with status `disconnected`.
- **Limits on connect steps** (429 with `Retry-After`, the sentence in `error`): per user (`sub`), at most
  `BROKER_CONNECT_PER_USER` (20) starts and renews in 10 minutes, 20 E\*TRADE verifies and 60 login links; for the
  whole process, at most `BROKER_CONNECT_GLOBAL_PER_MIN` (60) new IBKR or E\*TRADE starts a minute. Refused attempts
  are not written to `audit_events` one by one.
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
  sandbox keys alike; reads go to `https://api.etrade.com` or `https://apisb.etrade.com`.
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
| `ETRADE_ALLOW_SANDBOX` | `true` outside production, `false` in production | accept sandbox keys |
| `BROKER_GLOBAL_RPS` | 50 | process-wide broker calls per second |
| `BROKER_CONNECT_PER_USER` | 20 | IBKR and E\*TRADE starts plus renews per user in 10 minutes |
| `BROKER_CONNECT_GLOBAL_PER_MIN` | 60 | new IBKR and E\*TRADE connections per minute, whole process |
| `IBKR_MAX_PENDING_LOGINS` | half of `IBKR_GATEWAY_PORTS`, at least 2 | gateways waiting for a login at one time |
| `NODE_ENV` | development | `production` (the systemd unit sets it): https required for `PUBLIC_LOGIN_URL`, sandbox keys off by default |
| `LOG_LEVEL` | info | debug, info, warn, error, silent |

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
Java or the bundle is missing, and reports a skip if IBKR's servers cannot be reached.

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

# TLS and the two public names (DNS A records for broker.<domain> and ibkr-login.<domain> first)
sudo cp /opt/nasscord-broker/deploy/Caddyfile /etc/caddy/Caddyfile   # set NASSCORD_DOMAIN or edit the names
sudo systemctl reload caddy
```

Then set `BROKER_SERVICE_URL=https://broker.<domain>` in Vercel. Logs: `journalctl -u nasscord-broker -f` (JSON
lines; secrets are redacted by key name before anything is written). The unit uses `KillMode=control-group`, so
stopping or restarting the service always stops every gateway JVM with it. Run one instance only: gateway sessions
live in this process's memory.

Back up `BROKER_TOKEN_KEY` somewhere other than the VPS: without it the stored E\*TRADE tokens cannot be read
(users would reconnect with their consumer key and secret).

## Not done yet

- **Binding the IBKR login to the Nasscord user's browser.** The confirmation page, the 2-minute ticket and the
  same-origin Continue reduce the risk of a forwarded login link, but whoever holds a fresh link can still continue.
  The full fix needs the app: `/start` would redirect to an app route (for example
  `<NASSCORD_APP_URL>/api/broker/ibkr/confirm?c=<challenge>`) that checks the signed-in Nasscord session belongs to
  the user who started the connection and sends the browser back with a signed answer; only then is `nsibkr` set.
  That is a contract change (section 7) and an app route, outside this service.

