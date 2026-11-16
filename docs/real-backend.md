# Real backend: contract

This is the plan the code is built against: the demo data is removed, sign-in is real (Supabase), and a user connects their own broker accounts. The first release is **read-only**: accounts, balances, positions, orders and executions come from the broker, and order entry stays switched off until a later phase. Nasscord code can never place an order in this release: every broker call goes through a read-only allowlist (section 11).

Database schema: `supabase/migrations/20261103120000_init.sql` and `supabase/migrations/20261116120000_more_brokers.sql`. If this document and the SQL disagree, the SQL is right.

Brokers in this release (section 10 has the details):
- Connect for everyone: Interactive Brokers (gateway login), E*TRADE (the user's own developer key), Alpaca (the user's own API key, Live or their own Paper).
- Built, gated per method until each broker's approval arrives: Schwab, TradeStation, Tradier, tastytrade, Webull Connect, and SnapTrade for Fidelity, Robinhood, Public, Moomoo, Webull, Schwab (read only) and tastytrade.
- Not offered: Vanguard (SnapTrade connects it with the user's password), Merrill and Firstrade (need Plaid), Public's personal key (it can place trades), Moomoo direct (an OpenD gateway logged in with the user's password).

## 1. Parts

| Part | Where it runs | Holds |
|---|---|---|
| Next.js app (this repo, `src/`) | nasscord.com (the VPS, behind Caddy) | No broker secrets. Reads its own rows through the user's Supabase JWT (RLS). Writes with the service role after checking the session. |
| Supabase (new project) | supabase.com | Auth (email + password), Postgres tables, RLS. |
| Broker service (`services/broker/`) | The same US VPS, **one** Node 24 process (systemd), TLS from Caddy | The token-encryption key, the IBKR gateway processes, every call to every broker. |

The app talks to the broker service over HTTPS with a short-lived service JWT (section 5). The browser never calls the broker service directly, except to open the IBKR login page on the login host (section 7).

**Run the broker service as a single instance.** Its locks (one change at a time per connection, one token refresh at a time), rate buckets, read cache and circuit breakers are in memory. Two instances would refresh a rotating refresh token (Webull, some TradeStation keys) twice and lose the connection.

**Deploy order:** the migration first, then the broker service, then the app. The new service writes the new methods and tables; the app selects `data_as_of` and `scope`. The app falls back to the old columns when the migration has not run (Postgres 42703), but the order above is the supported one. Every existing row (IBKR production/paper, E*TRADE production/sandbox) satisfies the new checks.

**Never log a query string** anywhere: not in the app, not in the broker service, not in Caddy's access log. OAuth callbacks carry codes and states in the query, and the hop carries the binding nonce.

## 2. Environment variables

App (`.env.local` for development):

| Name | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon / publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only. Never imported into a client component. |
| `NEXT_PUBLIC_SITE_URL` | The canonical origin, `https://nasscord.com`: email links, and the host every broker returns to (it must equal the service's `OAUTH_CALLBACK_BASE`, and serve `/api/broker/callback/*` with no redirect) |
| `NEXT_PUBLIC_APP_DOMAIN` | Apex domain for workspace subdomains (existing) |
| `BROKER_SERVICE_URL` | e.g. `https://broker.nasscord.com` or `http://localhost:8710` |
| `BROKER_SERVICE_SECRET` | Shared HS256 secret for service JWTs (at least 32 random bytes) |
| `NASSCORD_SUPERADMIN_EMAILS` | Comma-separated. A signup with one of these emails, confirmed through a link Supabase emailed, becomes `superadmin`. |
| `NEXT_PUBLIC_ETRADE_SANDBOX` | `1` shows E*TRADE's Sandbox choice to developers. Never set in production. |

Broker service (`services/broker/.env`, or `/etc/nasscord-broker.env` on the VPS):

| Name | Purpose |
|---|---|
| `API_PORT` (8710), `LOGIN_PORT` (8711) | API listener and the public IBKR login listener |
| `PUBLIC_LOGIN_URL` | Public base of the login host, e.g. `https://ibkr-login.nasscord.com` or `http://localhost:8711` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Service-role access through PostgREST (`/rest/v1`) |
| `BROKER_SERVICE_SECRET` | Same value as the app |
| `BROKER_TOKEN_KEY` | base64 of 32 random bytes, AES-256-GCM key for `broker_secrets` and `broker_aggregator_users` |
| `BROKER_TOKEN_KEY_VERSION` | integer, default 1 |
| `IBKR_GATEWAY_BUNDLE` | Folder of the IBKR Client Portal Gateway (contains `dist/`, `build/lib/runtime/`, `root/`) |
| `IBKR_GATEWAY_RUNTIME` | Writable folder for per-slot config |
| `IBKR_GATEWAY_PORTS` | Slot range, default `7200-7249` |
| `JAVA_BIN` (`java`), `IBKR_GATEWAY_XMX` (`256m`) | JVM for the gateways |
| `ETRADE_ALLOW_SANDBOX` | Accept E*TRADE sandbox keys (sample data). Default `true` outside production. **Ignored when `NODE_ENV=production`** (a boot warning says so). |
| `NASSCORD_APP_URL` | The app's URL, for the "Back to Nasscord" link on the login host (`http://localhost:3000` locally) |
| `NODE_ENV` | `production` on the VPS (the systemd unit sets it): https URLs required, every sample-data environment refused |
| `OAUTH_CALLBACK_BASE` | The canonical origin every broker redirects to: `https://nasscord.com`. The redirect URI is `<base>/api/broker/callback/<broker>`. Https in production; outside production it defaults to `NASSCORD_APP_URL` or `http://localhost:3000`. Without it, OAuth and SnapTrade methods are "not configured". Frozen: changing it means every Schwab app and TradeStation key has to be approved again. |
| `BROKER_AUDIENCE` | Who may use each connect method (section 9). Comma-separated `method=all\|superadmin\|off` |
| `BROKER_URL_OVERRIDES` | JSON `{"<broker package>":{"<name>":"http://127.0.0.1:9001"}}` for local fake brokers. **Refused in production.** |
| `ALPACA_CLIENT_ID`, `ALPACA_CLIENT_SECRET` | Alpaca Connect (Nasscord's OAuth app), later |
| `TRADIER_CLIENT_ID`, `TRADIER_CLIENT_SECRET` | Tradier partner OAuth client |
| `TRADIER_REFRESH_TOKENS` | `true` once Tradier enables refresh tokens for Nasscord (default `false`: access ends after 24 h) |
| `TRADIER_SANDBOX_TOKENS` | `true` only after Tradier confirms in writing that users may paste their own sandbox (paper) token (default `false`) |
| `SCHWAB_CLIENT_ID`, `SCHWAB_CLIENT_SECRET` | Nasscord's Schwab Commercial app, later. The per-user Individual app needs nothing here. |
| `TASTYTRADE_CLIENT_ID`, `TASTYTRADE_CLIENT_SECRET` | tastytrade OAuth client (the owner's personal app until tastytrade verifies Nasscord) |
| `TASTYTRADE_ENV` | `production` (default) or `cert` (sample data: **refused in production**) |
| `TASTYTRADE_API_VERSION` | `Accept-Version` header, default `20261012` |
| `TRADESTATION_CLIENT_ID`, `TRADESTATION_CLIENT_SECRET` | Nasscord's own TradeStation key, once TradeStation accepts Nasscord as a partner |
| `TRADESTATION_ALLOW_SIM` | `true` offers TradeStation Paper (SIM) once a real login confirms SIM shows only the user's own activity (default `false`) |
| `WEBULL_CLIENT_ID`, `WEBULL_CLIENT_SECRET`, `WEBULL_APP_KEY`, `WEBULL_APP_SECRET` | Webull Connect. The app key and secret only sign requests; they are never sent. |
| `WEBULL_ENV` | `production` (default) or `sandbox` (Webull's required sandbox testing: **refused in production**) |
| `SNAPTRADE_CLIENT_ID`, `SNAPTRADE_CONSUMER_KEY` | SnapTrade partner keys |
| `SNAPTRADE_BROKERS` | Brokers SnapTrade may connect, default `fidelity,robinhood,public,moomoo,webull`; `schwab` and `tastytrade` may be added once SnapTrade enables them |
| `SNAPTRADE_PLAN` | `daily` (default) or `realtime`: SnapTrade's data plan (read cache length) |

Every credential pair must be set together. Configuration errors name the variable and the rule, never the value.

Optional, with defaults: `API_HOST` and `LOGIN_HOST` (`127.0.0.1`), `LOG_LEVEL` (`info`), `BROKER_GLOBAL_RPS` (50), `BROKER_TOKEN_KEYS_PREVIOUS` (old keys during a rotation), `BROKER_CONNECT_PER_USER` (20), `BROKER_CONNECT_GLOBAL_PER_MIN` (60), `IBKR_MAX_PENDING_LOGINS` (half the slots). The table in `services/broker/README.md` is the full list.

## 3. Auth and roles

- Supabase Auth, email + password, email confirmation on. `@supabase/ssr` keeps the session in cookies. `src/proxy.ts` refreshes the session on every request and gates `/app`, `/admin` and `/tenant`.
- The role lives in `public.members` and is copied into the user's `app_metadata` (`role`, `workspace_id`, `tenant_id`) by server code with the service role, so the proxy can read it from verified JWT claims without a database call. Layouts still check `members` on the server (`requireRole`).
- No `members` row yet (signed up, workspace not created): the user is sent to `/signup` to finish.
- Roles and areas stay as in `src/lib/roles.ts`: `superadmin` (console, terminal, tenant portal), `tenant` (tenant portal), `trader` and `tenant_user` (terminal).
- Superadmin bootstrap: when the member row is created, an email listed in `NASSCORD_SUPERADMIN_EMAILS` gets role `superadmin`, but only when Supabase emailed a confirmation link for it (`confirmation_sent_at` set): with Confirm email off every address counts as confirmed, so nobody is promoted. There is no other way to become superadmin from the app.
- `/auth/confirm` does not follow `next` freely: a recovery link always lands on `/login/reset`, any other link on `/signup` unless `next` is one of a few app pages (`/app`, `/admin`, `/tenant`, ...), never an `/api` route. An email link signs in whoever opens it as the token's account, so a free `next` would let someone land another person on a page acting for their own account.
- `updatePassword` only works within an hour of a sign-in by email link (the session's `amr` claim shows `recovery`, `otp` or `magiclink`), so a session from a password sign-in cannot change the password.
- A console change of workspace status (`suspended`, `past_due`) is recorded only: no layout, route or the broker service acts on it in this release.
- A tenant code at signup that matches `tenants.referral_code` of an active tenant sets `workspaces.tenant_id`, and the user's role becomes `tenant_user`. Without a code the role is `trader`.
- Email links (set these templates in Supabase, Auth, Email templates):
  - Confirm signup: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/signup`
  - Reset password: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/login/reset`
- Removed: demo identities, one-click role buttons, the unsigned `ns_session` cookie, the fake 2FA step, and fake Google/Apple buttons.

## 4. App data routes (Next route handlers, Node runtime)

Every route checks the Supabase session and the member row, and uses the member's `workspace_id`, except the canonical-host routes marked "no session", which are authorised by the login's own nonces (section 8). Errors are `{ "error": "<sentence a user can read>" }` with a 4xx/5xx status, or a short escaped HTML page for the navigation routes.

| Method and path | Body | Returns |
|---|---|---|
| `GET /api/broker/connections` | | `{ connections: BrokerConnection[] }` (rows from the DB, balances merged in from the service when the connection is active) |
| `GET /api/broker/positions` | | `{ positions: Position[] }` |
| `GET /api/broker/orders` | | `{ orders: Order[] }` |
| `GET /api/broker/executions` | | `{ executions: Execution[] }` |
| `PATCH /api/broker/accounts/[id]` | `{ included: boolean }` | `{ ok: true }` |
| `GET /api/broker/options` | | `BrokerOptions` for this user (section 9); may be cached briefly per role |
| `POST /api/broker/etrade/start` | `{ environment: "production" \| "sandbox", consumerKey, consumerSecret }` | `{ connectionId, authorizeUrl }` |
| `POST /api/broker/etrade/verify` | `{ connectionId, verifier }` | `{ connection: BrokerConnection }` |
| `POST /api/broker/ibkr/start` | `{ environment: "production" \| "paper" }` | `{ connectionId }` (then open `/api/broker/ibkr/login/[id]`) |
| `GET /api/broker/ibkr/login/[id]` | | `303` to a fresh login link on the login host (signed out: `/login?next=`; otherwise a short page with the reason). See section 7 |
| `POST /api/broker/key/connect` | `{ brokerId, method?, environment?, keyId?, secret, connectionId? }` | `{ connection: BrokerConnection }` (api_key flow; `connectionId` = replace the key of that connection) |
| `POST /api/broker/oauth/start` | `{ brokerId, method?, client?, environment?, clientId?, clientSecret? }` | `{ connectionId, openUrl }` + `Set-Cookie: ns_oauth_<connectionId>` (section 8) |
| `POST /api/broker/aggregator/start` | `{ brokerId, environment? }` | `{ connectionId, openUrl }` + the same cookie |
| `GET /api/broker/oauth/go?cid&n` | | canonical host, no session: a confirmation page naming the workspace and who asked; its Continue button posts back |
| `POST /api/broker/oauth/go` | form `cid`, `n` | canonical host, no session, same-origin only: sets the canonical cookie and answers `303` to the broker's page |
| `GET /api/broker/callback/[broker]` | | canonical host, no session: the one URL registered with every broker (section 8). `303` to the user's host with a ticket, or a page with the reason |
| `GET /api/broker/oauth/finish?cid&ticket` | | the user's own host, session required: claims the login, clears the cookie, `303` to `/app/brokers?connected=<id>` |
| `GET /api/broker/connections/[id]` | | `{ connection: BrokerConnection }` (asks the service for fresh status) |
| `POST /api/broker/connections/[id]/renew` | | `{ connection, next?: RenewNext, needsLogin?: true, authorizeUrl?: string }`, plus the binding cookie when `next.kind` is `redirect` (its `url` is the hop) |
| `DELETE /api/broker/connections/[id]` | | `{ ok: true }` |

`src/lib/api` keeps thin browser functions over these routes, and `src/hooks/queries.ts` the React Query hooks (keys include the workspace id; the cache is cleared on sign-out). The new routes and their browser functions and hooks belong to the app-routes work package.

Only the terminal roles (`superadmin`, `trader`, `tenant_user`) with a workspace reach these routes; a tenant login gets 403. Connect steps are limited to 10 of each kind per user in 10 minutes in the app (per instance, a burst guard) and by the broker service (binding, section 6).

Console and tenant portal pages are server components. They read through server-only modules in `src/lib/server/` with the service role, after `requireRole`. They write with server actions that check the role again and append an `audit_events` row.

### Type changes (`src/lib/types.ts`)

- `BrokerConnection` has `id`, `method` (`ConnectionMethod`), `environment` (`"production" | "sandbox" | "paper"`), `statusDetail?`, `sessionExpiresAt?`, and now `dataAsOf?` (aggregator sync time) and `scope?` (OAuth scope granted).
- `ConnectionMethod`: `ibkr_gateway`, `ibkr_oauth` (reserved), `etrade_oauth1`, `alpaca_key`, `alpaca_oauth`, `tradier_token`, `tradier_oauth`, `schwab_oauth`, `tastytrade_oauth`, `tradestation_oauth`, `webull_oauth`, `snaptrade`.
- `ConnectionStatus` is `"connected" | "expiring" | "pending" | "expired" | "error" | "disconnected"`. DB `active` maps to `connected`, or to `expiring` inside the broker's warn window: 2 hours, or 48 hours for Schwab's weekly login (`reconnectWarnHours` in `src/lib/broker-connect`).
- New: `ConnectFlow`, `ConnectClient`, `ConnectAudience`, `ConnectSpec` (how a broker connects, in the user's words), `ConnectOption` and `BrokerOptions` (what the service allows this user now), `RenewNext`. `Broker` gains `connect: ConnectSpec[]`.
- `BrokerAccount.id` is `broker_accounts.id` (uuid). `masked` is `display_number`.
- `Position` has optional `marketValue`, `unrealizedPnl`, `currency` and `secType`.

`src/lib/broker-connect/` holds one spec file per broker (steps, fields, disclosures, session and disconnect notes, the reason shown while unavailable) and the helpers `connectChoices(brokerId, options)`, `environmentLabel`, `reconnectWarnHours`, `METHOD_LABEL`. `src/lib/brokers.ts` keeps names, monograms, colors and the static release status for the public pages; the connect UI asks the service (`GET /api/broker/options`) and renders `connectChoices`.

## 5. Service JWT (app to broker service)

HS256, signed with `BROKER_SERVICE_SECRET`, sent as `Authorization: Bearer <jwt>`.
Header `{"alg":"HS256","typ":"JWT"}`. Claims:
`{ "iss": "nasscord-app", "aud": "nasscord-broker", "sub": "<user uuid>", "wid": "<workspace uuid or null>", "role": "<role>", "iat": <s>, "exp": <iat + 60> }`.
The service rejects a token that is expired, issued more than 120 s in the future, or has the wrong `aud` or `iss`. Both sides implement it with `node:crypto` (no JWT library). Compare signatures with `timingSafeEqual`.

The canonical-host steps (the hop and the callback, section 8) have no signed-in user. The app signs them with `FLOW_ACTOR` (`src/lib/server/broker-service.ts`): the nil user `00000000-0000-0000-0000-000000000000`, no workspace, role `trader`. The service authorises those two steps by the login's nonces alone and audits them as the connection's owner; every other route refuses this actor (no workspace).

## 6. Broker service API

JSON over HTTP on `API_PORT`. Everything under `/v1` needs the service JWT. Every connection id is checked against `wid` before use, except that `superadmin` may read `/v1/health`, and the two canonical-host steps (marked "flow") are authorised by the login's nonces.

| Method and path | Body | Returns |
|---|---|---|
| `GET /health` | | `{ ok, version, uptimeSec }` (no auth: liveness only) |
| `GET /v1/health` | | `{ connections: { <every broker id>: { <status>: count } }, adapters: [method], gateways }` (superadmin only) |
| `GET /v1/options` | | `{ callbackBase, options: ConnectOption[] }` for the caller (section 9) |
| `POST /v1/etrade/start` | `{ environment, consumerKey, consumerSecret }` | `{ connectionId, authorizeUrl }` |
| `POST /v1/etrade/verify` | `{ connectionId, verifier }` | `{ connection }` |
| `POST /v1/ibkr/start` | `{ environment }` | `{ connectionId, loginUrl }` |
| `POST /v1/ibkr/:id/ticket` | | `{ loginUrl }` with a fresh one-time ticket (400 for another broker's connection, 404 for another workspace's, 409 `no_gateway` or `disconnected`). See section 7 |
| `POST /v1/keys/connect` | `{ brokerId, method?, environment?, keyId?, secret, connectionId? }` | `{ connection }`. A key of a login the workspace already has reuses that connection; with `connectionId` a key of another account is a 409 `other_account` |
| `POST /v1/oauth/start` | `{ brokerId, method?, client?, environment?, clientId?, clientSecret?, returnOrigin, bindingHash }` | `{ connectionId }` |
| `POST /v1/aggregator/start` | `{ brokerId, environment?, returnOrigin, bindingHash }` | `{ connectionId }` |
| `POST /v1/connect/hop` (flow) | `{ connectionId, binding, repeat?, preview? }` | `{ redirectUrl, brokerId, workspaceName, requestedBy }` (`requestedBy` is a masked email; with `preview: true` no `redirectUrl` and nothing is used up) |
| `POST /v1/oauth/complete` (flow) | `{ brokerId, state, code?, error?, bindings: { <connectionId>: nonce } }` | `{ connectionId, returnOrigin, ticket }` |
| `POST /v1/aggregator/complete` (flow) | `{ connectionId, status, authorizationId?, binding }` | `{ connectionId, returnOrigin, ticket }` |
| `POST /v1/connect/claim` | `{ connectionId, ticket, binding }` | `{ connection }` (the caller must be the user who started it) |
| `GET /v1/connections/:id` | | `{ connection }` |
| `POST /v1/connections/:id/renew` | `{ returnOrigin?, bindingHash? }` | `{ connection, next?, loginUrl? }` |
| `DELETE /v1/connections/:id` | | `{ ok: true }` |
| `GET /v1/portfolio` | | `{ accounts: [{ accountId, netLiq?, buyingPower?, cash?, dayPnl?, currency }], positions: Position[], errors: [{ connectionId, message }] }` (a value the broker did not report is left out, never sent as 0) |
| `GET /v1/orders` | | `{ orders: Order[], errors }` |
| `GET /v1/executions` | | `{ executions: Execution[], errors }` |
| `POST /hooks/<name>` | raw body, at most 64 KB | no service JWT: handed to the adapter of that method or broker (`/hooks/snaptrade`), which checks the broker's own signature. 404 when no adapter takes it |

`connection` in these responses: `{ id, brokerId, method, environment, status, statusDetail, sessionExpiresAt, lastOkAt, dataAsOf?, scope?, accounts: [{ id, label, displayNumber, type, included }] }`, with `status` as stored in the DB. `dataAsOf` and `scope` are sent only when set; `external_ref` is never sent. The app maps it to `BrokerConnection`.

`next` from renew (`RenewNext`): `{ kind: "gateway_login" }` (IBKR: open the login route), `{ kind: "oauth1_verifier", authorizeUrl }` (E*TRADE), `{ kind: "api_key" }` (paste the key again: replace-key mode), `{ kind: "redirect" }` (OAuth and SnapTrade: a new login through the hop; the service needs `returnOrigin` and `bindingHash` in the body, otherwise 400 `needs_login`). No `next`: the connection is fine. Renew first tries the adapter's own refresh. For OAuth and SnapTrade a renew **with** `returnOrigin` and `bindingHash` (the Reconnect button) always starts a new login, even while the session still works (that is the only way to move a fixed end such as Schwab's 7 days); without them it only refreshes. A renew passes the `BROKER_AUDIENCE` gate again (403 `off` / `owner_only`) whenever it may start a login or ask for a new key: for IBKR, E*TRADE and SnapTrade, whose adapters renew themselves, that is every renew (a same-day E*TRADE token renewal, an IBKR renew while still logged in and a SnapTrade check of a working connection included), and for the other methods only the renew that starts a login or asks for a new key. In production a sandbox connection is refused (400 `sandbox_refused`). A connection whose environment this server no longer offers (TradeStation Paper without `TRADESTATION_ALLOW_SIM`, a Tradier Paper token without `TRADIER_SANDBOX_TOKENS`) is refused up front with 409 and the adapter's sentence (`sim_off`, else `environment_off`): no refresh, no hand-off row, and the connection keeps its detail and tokens.

Only `included` accounts feed `/v1/portfolio`, `/v1/orders` and `/v1/executions`. Each adapter declares how long a read answer is reused (`readTtlMs`: 5 s for IBKR and E*TRADE, longer for brokers with tight limits, up to 10 minutes for SnapTrade), so many tabs polling cost one broker call. Rate limits are token buckets per adapter (IBKR 8 req/s per username, E*TRADE 2 req/s per connection and module, each new broker its own) and one global bucket per process; a 429 or Tradier's "Quota Violation" pauses the bucket for the broker's Retry-After. Connect steps are limited per user: 20 starts and renews in 10 minutes, 20 verifies and claims, 60 IBKR login links; and at most 60 new connections a minute for the whole process (429 with `Retry-After`). At most half the gateway slots may wait for an unfinished login (503 `too_many_pending`). The service writes `audit_events` for every connect step, renew and disconnect; its own system events (expiries, gateway restarts and exits) carry the connection's `workspace_id`. Audit rows never hold a key, token, code, state or nonce.

Secrets (`broker_secrets`): AES-256-GCM, a random 12-byte IV, the connection id as AAD, base64 fields, `key_version`. The plaintext is JSON, per method:

| Method | Plaintext |
|---|---|
| `etrade_oauth1` | `{ consumerKey, consumerSecret, requestToken?, requestSecret?, accessToken?, accessSecret? }` |
| `ibkr_gateway` | nothing: the login happens on IBKR's own page and the session lives in the gateway process |
| `alpaca_key` | `{ keyId, secretKey, host: "live" \| "paper" }` |
| `tradier_token` | `{ token, host: "live" \| "sandbox" }` |
| `*_oauth` (Schwab, TradeStation, Tradier, tastytrade, Webull, Alpaca Connect) | `{ client: "user" \| "platform", clientId?, clientSecret?, redirectUri, accessToken?, accessExpiresAt?, refreshToken?, refreshIssuedAt?, refreshExpiresAt?, scope?, extra? }`. `clientId` and `clientSecret` only for the user's own app; a platform client's credentials stay in the service env. `extra` is the adapter's (Schwab's account hash map). Disconnect and expiry drop the tokens; Reconnect keeps the user's app. |
| `snaptrade` | no per-connection secret. The workspace's SnapTrade `userSecret` is in `broker_aggregator_users`, sealed with the same key and AAD `snaptrade:<workspace_id>`. |

## 7. IBKR (Client Portal Gateway, one process per connection)

- The service spawns `java` directly (no Docker): classpath `<bundle>/root`, `<bundle>/dist/ibgroup.web.core.iblink.router.clientportal.gw.jar` and `<bundle>/build/lib/runtime/*`, main class `ibgroup.web.core.clientportal.gw.GatewayStart`, `--conf <runtime>/slot-<port>/conf.yaml`. The conf is rendered from the bundle's `root/conf.yaml` with `listenPort: <slot>`, `listenSsl: false`, and `ips.allow` limited to `127.0.0.1`.
- Slots come from `IBKR_GATEWAY_PORTS`. One slot per connection, released on disconnect, as soon as a login window ends without a login, 30 minutes after a logged-in session expired, or when the process exits. The JVM gets a minimal environment, never the service's secrets.
- Opening the login, tied to the signed-in user. The browser never receives a login link from the broker service: the service's `loginUrl` from start and renew stays on the server (`POST /api/broker/ibkr/start` answers only `connectionId`, and renew answers `needsLogin` and `next.kind = "gateway_login"` for IBKR). The connect dialog and Reconnect open the app's own route in a new tab:
  - `GET /api/broker/ibkr/login/[id]` (app, Node runtime) only answers a navigation that started on the app itself: when the browser sends `Sec-Fetch-Site` and it is not `same-origin` (a link in an email, another site, the address bar), it answers a page that says to open the login from Brokers. It then checks the Supabase session and the member row, and that connection `id` belongs to the member's workspace (signed out: `/login?next=` back to this route). It then calls the service with the member's service JWT, and answers `303` to the `loginUrl` it gets back (`Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`). When the login cannot be opened it answers a short page with the reason and a link to `/app/brokers`.
  - `POST /v1/ibkr/:id/ticket` (service, service JWT) runs the same workspace check as every `/v1/connections/:id` route (another workspace's connection is a 404), refuses another broker's connection (400), and answers `{ loginUrl }` with a fresh ticket while the connection's gateway is running. It starts nothing: without a running gateway it answers 409 (`no_gateway`, "Press Reconnect"), and 409 (`disconnected`) after a disconnect. Every link is audited as `broker.ibkr.login_link`.
  - So the ticket the browser follows is seconds old, and a copied link to the app route only works for someone signed in to the same workspace. Whoever holds the login host URL itself during its 2-minute life can still open it; the confirmation page below names whose workspace the login joins.
- Login host (`LOGIN_PORT`, published as `PUBLIC_LOGIN_URL`):
  - Tickets are HMAC-SHA256 with `BROKER_SERVICE_SECRET` over `{ cid, exp, n }` (`n` a random nonce), live 2 minutes and work once.
  - `GET /start?t=<ticket>` checks the ticket without using it and shows a confirmation page before anything of IBKR loads: the IBKR account logged in there joins the Nasscord workspace it names (marked as a name its owner chose), at the request of the masked email of the user who started the connection, with a **Continue to the IBKR login** button. No cookie is set yet.
  - `POST /start` (the button, same-origin only: `Sec-Fetch-Site` must be `same-origin` and `Origin` must match the host when sent) uses the ticket, sets the cookie `nsibkr=<cid>.<exp>.<sig>` (HttpOnly, SameSite=Lax, Path=/, Secure when the public URL is https, 1 hour) and redirects to `/` (303).
  - Every other request is routed by that cookie to the slot's gateway, through an allowlist of the login paths only (the SSO pages and their assets, plus `GET /v1/api/iserver/auth/status`). Any other `/v1/api` path returns 403 on the public host. Once the gateway reports the login, `/` shows a "You are logged in" page.
  - The proxy follows NOVA's hardening (`D:\ibkr sagar nipani\trad\quant-forge-os\server-proxy.cjs`): it strips `X-Forwarded-For`, `X-Real-IP` and `X-Forwarded-Host`, opens a fresh loopback connection per request, rewrites `Set-Cookie` to host-only and `Location` to relative, and retries a GET once on a parse error.
- Keepalive per gateway: `POST /v1/api/tickle` every 55 s and a `GET /v1/api/iserver/auth/status`. On the first authenticated status: `POST /iserver/auth/ssodh/init {"publish":true,"compete":false}`, then `GET /iserver/accounts` and `GET /portfolio/accounts`, then upsert `broker_accounts` and set the status to `active` with `session_expires_at` 24 h ahead. If the gateway reports `competing`, the status detail says so. The service never sends `compete: true` on its own.
- Reads: `/portfolio/{acct}/summary`, `/portfolio/{acct}/positions/{page}`, `/iserver/account/orders`, `/iserver/account/trades`, `/iserver/account/pnl/partitioned` (day P&L).
- Later, an IBKR OAuth 1.0a adapter (`method: "ibkr_oauth"`) will replace the gateway behind the same interface.

## 8. Connect flows

Six flows (`ConnectFlow`). IBKR (`gateway_login`, section 7) and E*TRADE (`oauth1_verifier`, below) keep their own routes; the other four are generic.

**E*TRADE (OAuth 1.0a with the user's own consumer key).**
- An individual E*TRADE key only works for the account of the person who owns it. Each user creates a key on developer.etrade.com and pastes the consumer key and secret into Nasscord. Production keys only for users: Sandbox (E*TRADE's sample accounts) appears only with `NEXT_PUBLIC_ETRADE_SANDBOX=1` and a broker service outside production, labelled "Sandbox · sample data".
- `GET https://api.etrade.com/oauth/request_token` with `oauth_callback=oob`, HMAC-SHA1. The request token lives 5 minutes.
- The user opens `https://us.etrade.com/e/t/etws/authorize?key=<consumerKey>&token=<requestToken>`, approves, and copies the verification code back into Nasscord.
- `GET https://api.etrade.com/oauth/access_token` with the request token and `oauth_verifier`. The access token and secret are stored encrypted.
- API base: `https://api.etrade.com` for production, `https://apisb.etrade.com` for sandbox. Use `accountIdKey` in every path.
- Tokens end at midnight US Eastern and go inactive after 2 hours idle. Renewal (`/oauth/renew_access_token`) works the same day only. At 00:00 ET the service marks the connection `expired` with the detail "E*TRADE ends every session at midnight Eastern. Reconnect to continue."
- Rate limit: treat an HTTP 400 with an HTML body as rate limited and back off. Revoke the token on disconnect (`/oauth/revoke_access_token`).
- Reads: `/v1/accounts/list`, `/v1/accounts/{key}/balance?instType=BROKERAGE&realTimeNAV=true`, `/v1/accounts/{key}/portfolio`, `/v1/accounts/{key}/orders`.

**api_key (Alpaca key and secret; the owner's own Tradier token).** The dialog posts the key once to `POST /api/broker/key/connect`; the adapter checks it with a read call (Alpaca: `GET /v2/account`, live host then paper host) and answers the environment, the broker-side identity (`external_ref`, e.g. the Alpaca account id) and the accounts. A key of a login the workspace already has updates that connection, so its Included switches survive; when that connection was made another way (Alpaca Connect), it moves to the key method and its secret is replaced whole. When the broker stops accepting the key (401), the connection becomes `expired` with "Alpaca no longer accepts this key. Paste the new key.", and renew answers `next.kind = "api_key"`: the dialog re-keys the same connection (`connectionId`), and a key of a different account is refused (409). Disconnect deletes the key; it does not revoke it at the broker.

**oauth2_user_app, oauth2_platform and aggregator_portal: the canonical-host hand-off.** Supabase cookies are host-only, and users sit on nasscord.com, workspace subdomains or white-label tenant domains, while every broker returns to one registered URL. A tenant controls its custom domain's DNS, so a code or portal result must never travel in a URL to a host other than the canonical one. The hand-off has four steps:

1. **Start** (the user's own host, signed in): `POST /api/broker/oauth/start` (or `/aggregator/start`). The app checks the return origin against its allowlist (the canonical site, `https://<slug>.<NEXT_PUBLIC_APP_DOMAIN>` for a slug a workspace holds and never a reserved name such as `ibkr-login`, `status` or `mail` (`RESERVED_SLUGS` in `src/lib/signup.ts`), active white-label tenant domains, `http://localhost:3000` in development), makes a random nonce N, and calls the service with `returnOrigin` and `bindingHash = sha256(N)`. The service creates a `pending` connection (detail "Approve access on <Broker> to finish connecting.") and a `broker_oauth_pending` row (stage `start`, 10 minutes). For the user's own app the adapter first checks the pasted key's format (`checkClient`; TradeStation refuses its legacy keys with 400 `tradestation_legacy_key` before any row is written), then the service stores `{ client: "user", clientId, clientSecret, redirectUri }` sealed. The app sets `ns_oauth_<connectionId>=N` on the user's host (HttpOnly, SameSite=Lax, Secure on https, Path=/api/broker, Max-Age=600) and answers `openUrl = <canonical>/api/broker/oauth/go?cid=<id>&n=<N>`, which the dialog opens in a new tab.
2. **Hop** (canonical host, no session): `GET /api/broker/oauth/go` calls `POST /v1/connect/hop { connectionId, binding: N, preview: true }` (the same checks, nothing used up) and shows a confirmation page naming the workspace and the masked email of who asked, with a Continue button that posts `cid` and `n`. `POST /api/broker/oauth/go` (same-origin) calls `POST /v1/connect/hop { connectionId, binding: N, repeat }` (`repeat: true` only when this host already holds `ns_oauth_<cid>` with the same N), sets the same cookie on the canonical host, and answers `303` to `redirectUrl`. The service checks sha256(N), moves the row to stage `authorize` once, and for OAuth makes a fresh 32-byte state (only its sha256 is stored) and the broker's authorize URL (PKCE S256 when the broker uses it); for SnapTrade it asks the adapter for a portal link (broker preselected, read-only connection type) whose `customRedirect` is `<canonical>/api/broker/callback/snaptrade?cid=<id>`.
3. **Callback** (canonical host, no session): the broker sends the browser to `<canonical>/api/broker/callback/<broker>`. For OAuth the app sends `{ brokerId, state, code | error, bindings }` to `POST /v1/oauth/complete`, where `bindings` is every `ns_oauth_<id>` cookie the canonical host holds; for SnapTrade it sends `{ connectionId: cid, status, authorizationId, binding }` to `POST /v1/aggregator/complete`. The service takes the row by sha256(state) in one atomic update (single use), checks the window and the binding, exchanges the code at once (Schwab's code lives about 30 s), stores the tokens sealed **before** using them, lets the adapter name the login (`external_ref`; a login that names none is a 500), and moves the row to stage `claim` with sha256 of a fresh one-time ticket (5 minutes). On a Reconnect the login must be the one the connection holds: another login is refused with 409 `other_account` (a Schwab login named by the `h:` hash of its account list may change with that list, but never onto another connection's login: 409 `other_connection`). It answers `{ connectionId, returnOrigin, ticket }`; the app answers `303` to `<returnOrigin>/api/broker/oauth/finish?cid=<id>&ticket=<ticket>` (`Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`). A missing or wrong binding, an expired window, a denied approval or a failed exchange removes a connection that never connected (or expires a Reconnect and drops any new tokens) and answers the reason, which the app shows on a short page with a link back to Brokers. For SnapTrade, a refusal at this step (binding, window or status) also deletes the SnapTrade connection that login's portal made, when SnapTrade dated it after the login started and no connection holds it, so a forwarded portal link leaves nothing under the starter's SnapTrade user; and a new connection takes only a SnapTrade connection made since its own login started (400 `stale_authorization` otherwise; a Reconnect comes back with the one it holds).
4. **Finish** (the user's own host, session required): `GET /api/broker/oauth/finish` reads `ns_oauth_<cid>` and calls `POST /v1/connect/claim { connectionId, ticket, binding }` with the user's own JWT. The service checks the workspace, that the caller is the user who started, and takes the row by ticket in one atomic delete (single use), checks the binding, then activates the connection: when another live connection of the workspace has the same `external_ref` (any method of that broker: the one-login index has no method column), the new tokens move onto it (sealed again under its id) and the new row is deleted, so its Included switches survive. If that connection was made another way (an Alpaca key, then Alpaca Connect), it moves to the new login's method and its secret is replaced whole; an unfinished Reconnect of it (its hand-off row) is dropped. A Reconnect never merges (step 3 refused another login). Then it lists the accounts (on failure: active with "Connected. <Broker> has not sent the account list yet; it loads on the next refresh.", and the next read loads them, whatever the adapter's `lazyAccounts`). The claim answers the connection it activated, which after a merge is the existing one, not the id the start answered. The app clears the cookie and answers `303` to `/app/brokers?connected=<id>` with **the id the claim answered**. The dialog that opened the tab polls `GET /api/broker/connections/[id]` for the id it started; a 404 there after the login means the login was merged into an existing connection, and the dialog refreshes the connection list (the `connected` id names the one to highlight) instead of showing an error.

Why it holds: a victim who approves a login that an attacker started reaches the canonical callback without the attacker's canonical cookie, and the callback refuses (step 3). A forwarded hop link opens in the victim's browser behind a confirmation page that names the attacker's workspace, and even then the ticket only works with the starter's session and user-host cookie (step 4). Codes, states, tickets and nonces are never logged, never stored in the clear, and never sent to a non-canonical host.

Renew for these flows: the renew route sends `returnOrigin` and `bindingHash` and sets the cookie; the service passes the audience gate, writes a new hand-off row, answers `next.kind = "redirect"`, and the steps above run on the same connection, reusing the stored app key and secret. When the refresh says the session has ended, the connection goes to `pending` for the login. When the session still works (Reconnect pressed inside Schwab's last 48 hours, before TradeStation's 24 h or Webull's 15 days run out) it stays `active`, so reads go on during the login: the claim moves it to the new tokens and its new end. The app's dialog therefore waits for the finish redirect (or for `sessionExpiresAt` to move), not for the status to change. A login that ends on a fixed date (Schwab: 7 days from the browser login) shows "Session ending soon" 48 hours before and is expired by the scheduler at the deadline.

Abandoned logins: the scheduler removes hand-off rows past their window every minute. A connection that never connected goes with it; one that was being reconnected becomes `expired` ("The login was not finished within 10 minutes. Start again.", or "The login was not finished in Nasscord. Start again." after an unclaimed exchange) and loses the unclaimed tokens. A connection that is still `active` (a Reconnect of a working session) keeps working: a login refused after the exchange puts its previous secret back, and an unclaimed one leaves the new tokens of the same login in place; only tokens of another login (never accepted, see step 3) would expire it. A new start also removes the workspace's earlier dead attempts at the same broker. A hop that fails after taking the row (the broker's link, the PKCE save) puts it back, so "Open login" works again; a second hop of the same row needs `repeat: true`, and its new state makes the earlier one useless.

## 9. Who may connect (BROKER_AUDIENCE)

Each connect method, and for Schwab and TradeStation each client, has a gate key with an audience: `all` (every user with a trading workspace), `superadmin` (the platform owner only) or `off`. A method is available to a user when its adapter is built, it is configured (its env credentials, and `OAUTH_CALLBACK_BASE` for OAuth and SnapTrade), the audience lets the user in, and an environment is left once sample data is dropped in production. `GET /v1/options` answers this per method, client and broker with a `reasonCode` (`not_built`, `not_configured`, `off`, `owner_only`, `no_environment`) and a sentence (the owner sees which setting is missing). The IBKR and E*TRADE start routes check the audience too, and so does Reconnect, so a method switched `off` or to `superadmin` cannot be logged into through it: for IBKR, E*TRADE and SnapTrade every Reconnect is gated (their adapters renew themselves and may start a login), for the other methods only a renew that starts a new login or asks for a new key (their plain refresh stays open). Existing connections keep reading either way.

| Gate key | Default | Why |
|---|---|---|
| `ibkr_gateway`, `etrade_oauth1`, `alpaca_key` | `all` | The user's own login or key, which each broker allows |
| `snaptrade` | `all` | Effective only once `SNAPTRADE_CLIENT_ID` and `SNAPTRADE_CONSUMER_KEY` are set, for the brokers in `SNAPTRADE_BROKERS` |
| `schwab_oauth.user` | `superadmin` | Schwab defines an Individual app as your own app for your own account: owner's testing until Schwab agrees in writing |
| `tradestation_oauth.user` | `superadmin` | A non-partner key reaches only its owner's accounts: owner's testing until TradeStation agrees in writing |
| `tradier_token` | `superadmin` | Tradier's API is for personal use unless you are a partner |
| `tastytrade_oauth` | `superadmin` | Until verification the client is the owner's personal OAuth app |
| `alpaca_oauth`, `tradier_oauth`, `schwab_oauth.platform`, `tradestation_oauth.platform`, `webull_oauth` | `superadmin` | Platform clients: unavailable until their env credentials exist, then the owner tests before opening them with `=all` |

`BROKER_AUDIENCE="schwab_oauth.user=all,tradier_token=off"` changes single keys; a bare `schwab_oauth=` or `tradestation_oauth=` sets both clients; `all=<audience>` sets every key first (local testing). Unknown keys are a configuration error.

## 10. Brokers

| Broker | Method | Environments | Session | Status in this release |
|---|---|---|---|---|
| Interactive Brokers | `ibkr_gateway` | Live, Paper (own) | about a day | everyone |
| E*TRADE | `etrade_oauth1` | Production (Sandbox: developers only) | ends at midnight ET | everyone |
| Alpaca | `alpaca_key` (`alpaca_oauth` later) | Live, Paper (own, one connection per paper account) | keys do not expire | everyone (`alpaca_key` audience `all`); the public pages show it as connecting from the service's `/v1/options`, while their static fallback (`status` in `src/lib/brokers.ts`, used only when the service cannot be asked) keeps it "Not available yet" |
| Charles Schwab | `snaptrade` (read only), `schwab_oauth` user app (owner), platform (Commercial, later) | Live only | new login every 7 days | waiting for SnapTrade and Schwab approvals |
| TradeStation | `tradestation_oauth` user key (owner), platform (later) | Live, Paper (SIM) only with `TRADESTATION_ALLOW_SIM` | no expiry, or 24 h when the key rotates refresh tokens | waiting for TradeStation |
| Tradier | `tradier_oauth` (partner), `tradier_token` (owner) | Live; Paper only by sandbox token with `TRADIER_SANDBOX_TOKENS` | 24 h without refresh tokens | waiting for the partner approval |
| tastytrade | `tastytrade_oauth`, `snaptrade` | Live (cert: developers only) | until the grant is removed | waiting for verification or SnapTrade |
| Webull | `snaptrade` now, `webull_oauth` after approval | Live (Connect sandbox: developers only) | 15-day refresh | waiting for SnapTrade or Webull |
| Fidelity, Robinhood, Public, Moomoo | `snaptrade` | Live | SnapTrade's sync (data_as_of) | waiting for SnapTrade production (Fidelity also its own profile approval) |

**Sample data never reaches users.** A sandbox, cert or demo environment is developer-only: the database keeps `sandbox` to `etrade_oauth1`, `tastytrade_oauth` and `webull_oauth`; the broker service refuses it when `NODE_ENV=production` (and refuses `TASTYTRADE_ENV=cert`, `WEBULL_ENV=sandbox` and `BROKER_URL_OVERRIDES` there outright), and a sandbox row left from before is neither read (each read answers it as an error entry: "This is a sandbox connection with sample data, which this server does not serve. Disconnect it.") nor renewed there; the UI labels it "Sandbox · sample data". `paper` is only the user's own paper account (IBKR, Alpaca, Tradier sandbox token, TradeStation SIM) and is labelled Paper. SnapTrade's demo and sandbox brokerages are refused by the adapter.

## 11. Adapters (broker service)

- `src/registry.mjs` maps each method to one adapter, validates every descriptor at boot (method, brokers, environments, read TTLs, sweep interval, clients, and the functions its flow needs) and answers `/v1/options`. `METHODS` there covers every method/broker pair the migration allows except the reserved `ibkr_oauth`, which has no adapter yet.
- `src/adapters.mjs` is the one static list of broker packages (`alpaca`, `tradier`, `schwab`, `tastytrade`, `tradestation`, `webull`, `snaptrade`). Each folder's `index.mjs` exports `createAdapter(deps)` (one adapter or an array), or `createAdapter = null` until its package lands: the registry skips it and the options answer `not_built`. IBKR and E*TRADE are registered through shims in their own folders (`ibkrRegistryAdapter`, `etradeRegistryAdapter`) with unchanged behaviour.
- The interface is documented in `src/adapter-types.mjs`: `descriptor`; reads (`portfolio`, or `balances` + `positions`; `orders`; `executions`; `listAccounts`); lifecycle (`refresh`, `renew?`, `revoke`, `forget`, `environmentsFor`, `configured`); flow hooks (`connectKey`, `oauthProfile` + `identify`, `portalUrl` + `aggregatorComplete` + `aggregatorRefused?`, `webhook`, `sweep`).
- `src/http.mjs` (`createBrokerHttp`) is the only way an adapter calls a broker: an allowlist of `[method, RegExp]` that must match the whole path, refused before any network call otherwise (`ReadOnlyViolation`); dot segments, encoded slashes and query strings in paths are refused; 429 and "Quota Violation" pause the bucket; 401/403 become `BrokerAuthError`; nothing is logged. Each adapter's allowlist holds its read endpoints and its token endpoint only, and each adapter has a test that proves it.
- Every login is named by `external_ref` (the one-login index and the duplicate merge depend on it): `connectKey()` and `identify()` must answer one, or the step fails. The broker's account or customer id where it has one (Alpaca account id, tastytrade customer id, Webull identity_id, SnapTrade authorization id); otherwise `loginRef()` from `src/oauth2.mjs`: the id_token `sub` (TradeStation, Schwab when it sends one), else sha256 of the App Key plus the sorted account hashes (Schwab), never the key itself.
- `src/oauth2.mjs` is the OAuth 2.0 engine every OAuth adapter uses through a profile (authorize and token URLs, an optional `refreshUrl` when the broker refreshes elsewhere (Tradier's `/v1/oauth/refreshtoken`), Basic, form or JSON client auth, redirect URI or not, scope, PKCE, refresh kind `none` / `fixed` / `rotating`, hard expiry, token request signing). Token answers read `expires_in` and the refresh life from `refresh_token_expires_in`, `refresh_expires_in` or `rt_expires_in` (Webull); `identify()` also gets the whole answer as `tokens.raw` (not enumerable, never stored or logged) for fields such as Webull's `identity_id`. Refresh happens lazily under the lock `token:<id>` when under 2 minutes are left; a rotated refresh token is saved before the new access token is used; `invalid_grant` or `invalid_client` expires the connection. A circuit breaker per broker and client (Nasscord's platform client, or each user's own app by a hash of its client id) pauses token calls for 10 minutes after 3 failures in 10 minutes; only network errors, timeouts, 5xx and `invalid_client` count, never one user's `invalid_grant` or a refused code, so one user's revoked grant or wrong app never pauses anyone else.
- `src/flows.mjs` holds the generic steps (section 8); `src/scheduler.mjs` adds two sweeps every minute: hand-off rows past their window, and `refresh()` (plus `sweep()`) of adapters that set `sweepEveryMs` (Schwab's 7-day mark, Tradier's 24 h, Webull's rotation, SnapTrade's authorizations).
- Broker URLs: each adapter has its production hosts; `BROKER_URL_OVERRIDES` (or the tests' `brokerUrls`) points a package at local fakes outside production.

## 12. Demo removal

- `src/lib/mock/` is deleted. Nothing imports demo data, and `DEMO_NOW` is replaced by the real clock.
- A page with no real source yet shows `EmptyState` with a plain sentence about what is missing. No fake numbers appear. Today that covers TradeScope alerts, the option ideas, the scanner and ticker prices (no market data feed), analysis history, billing, revenue, payouts, the referral funnel and plan pricing.
- `DemoFlag` is removed wherever the page now shows the user's own data.
- Brokers connect as section 10 says. A broker the user cannot connect right now shows "Not available yet" with the reason from its spec (or, for the owner, the missing setting), and the public pages say plainly which brokers connect today and which wait for an approval. They follow the broker service's `/v1/options` as an ordinary trader sees it (`publicBrokers()` in `src/lib/server/broker-availability.ts`, kept 5 minutes; the `(marketing)` layout revalidates every 300 s), and fall back to the static `status` in `src/lib/brokers.ts` (`RELEASED_BROKERS`: IBKR and E*TRADE) only while the service cannot be asked.
- The marketing pages may keep illustrations of the product. Those are static example data inside the marketing components, labelled as examples, and never read from `src/lib/api`.
- Public forms really save: the tenant application goes to `tenant_applications`, and the broker request goes to `broker_requests`.
- Order entry is off in this release: the ticket shows why, and the place button is disabled.
