# Real backend: contract

This is the plan the code is built against: the demo data is removed, sign-in is real (Supabase), and a user connects their own IBKR and E*TRADE accounts. The first release is **read-only**: accounts, balances, positions, orders and executions come from the broker, and order entry stays switched off until a later phase.

Database schema: `supabase/migrations/20261103120000_init.sql`. If this document and the SQL disagree, the SQL is right.

## 1. Parts

| Part | Where it runs | Holds |
|---|---|---|
| Next.js app (this repo, `src/`) | Vercel | No broker secrets. Reads its own rows through the user's Supabase JWT (RLS). Writes with the service role after checking the session. |
| Supabase (new project) | supabase.com | Auth (email + password), Postgres tables, RLS. |
| Broker service (`services/broker/`) | A US VPS, one Node 24 process (systemd or PM2), TLS from Caddy or nginx | The token-encryption key, the IBKR gateway processes, every call to IBKR and E*TRADE. |

The app talks to the broker service over HTTPS with a short-lived service JWT (section 5). The browser never calls the broker service directly, except to open the IBKR login page on the login host (section 7).

## 2. Environment variables

App (Vercel, `.env.local` for development):

| Name | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon / publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only. Never imported into a client component. |
| `NEXT_PUBLIC_SITE_URL` | Base URL used in email links, e.g. `https://nasscord-phi.vercel.app` |
| `NEXT_PUBLIC_APP_DOMAIN` | Apex domain for tenant subdomains (existing) |
| `BROKER_SERVICE_URL` | e.g. `https://broker.nasscord.com` or `http://localhost:8710` |
| `BROKER_SERVICE_SECRET` | Shared HS256 secret for service JWTs (at least 32 random bytes) |
| `NASSCORD_SUPERADMIN_EMAILS` | Comma-separated. A signup with one of these emails, confirmed through a link Supabase emailed, becomes `superadmin`. |

Broker service (`services/broker/.env`, loaded by the process manager):

| Name | Purpose |
|---|---|
| `API_PORT` (8710), `LOGIN_PORT` (8711) | API listener and the public IBKR login listener |
| `PUBLIC_LOGIN_URL` | Public base of the login host, e.g. `https://ibkr-login.nasscord.com` or `http://localhost:8711` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Service-role access through PostgREST (`/rest/v1`) |
| `BROKER_SERVICE_SECRET` | Same value as the app |
| `BROKER_TOKEN_KEY` | base64 of 32 random bytes, AES-256-GCM key for `broker_secrets` |
| `BROKER_TOKEN_KEY_VERSION` | integer, default 1 |
| `IBKR_GATEWAY_BUNDLE` | Folder of the IBKR Client Portal Gateway (contains `dist/`, `build/lib/runtime/`, `root/`) |
| `IBKR_GATEWAY_RUNTIME` | Writable folder for per-slot config |
| `IBKR_GATEWAY_PORTS` | Slot range, default `7200-7249` |
| `JAVA_BIN` (`java`), `IBKR_GATEWAY_XMX` (`256m`) | JVM for the gateways |
| `ETRADE_ALLOW_SANDBOX` | Accept sandbox keys. Default `true` outside production, `false` when `NODE_ENV=production` |
| `NASSCORD_APP_URL` | The app's URL, for the "Back to Nasscord" link on the login host (`http://localhost:3000` locally) |
| `NODE_ENV` | `production` on the VPS (the systemd unit sets it): `PUBLIC_LOGIN_URL` must be https, sandbox keys are off by default |

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

Every route checks the Supabase session and the member row, and uses the member's `workspace_id`. Errors are `{ "error": "<sentence a user can read>" }` with a 4xx/5xx status.

| Method and path | Body | Returns |
|---|---|---|
| `GET /api/broker/connections` | | `{ connections: BrokerConnection[] }` (rows from the DB, balances merged in from the service when the connection is active) |
| `GET /api/broker/positions` | | `{ positions: Position[] }` |
| `GET /api/broker/orders` | | `{ orders: Order[] }` |
| `GET /api/broker/executions` | | `{ executions: Execution[] }` |
| `PATCH /api/broker/accounts/[id]` | `{ included: boolean }` | `{ ok: true }` |
| `POST /api/broker/etrade/start` | `{ environment: "production" \| "sandbox", consumerKey, consumerSecret }` | `{ connectionId, authorizeUrl }` |
| `POST /api/broker/etrade/verify` | `{ connectionId, verifier }` | `{ connection: BrokerConnection }` |
| `POST /api/broker/ibkr/start` | `{ environment: "production" \| "paper" }` | `{ connectionId }` (then open `/api/broker/ibkr/login/[id]`) |
| `GET /api/broker/ibkr/login/[id]` | | `303` to a fresh login link on the login host (signed out: `/login?next=`; otherwise a short page with the reason). See section 7 |
| `GET /api/broker/connections/[id]` | | `{ connection: BrokerConnection }` (asks the service for fresh status) |
| `POST /api/broker/connections/[id]/renew` | | `{ connection: BrokerConnection, needsLogin?: true, authorizeUrl?: string }` (IBKR: log in again through the login route; E*TRADE: approve again on this page) |
| `DELETE /api/broker/connections/[id]` | | `{ ok: true }` |

`src/lib/api` keeps thin browser functions over these routes: `fetchConnections`, `fetchConnectionsResult`, `fetchPositionsResult`, `fetchOrdersResult`, `fetchExecutionsResult` (each with the per-connection `errors`), `setAccountIncluded`, `startEtrade`, `verifyEtrade`, `startIbkr`, `fetchConnection`, `renewConnection`, `disconnectConnection`. React Query keys include the workspace id, and the cache is cleared on sign-out.

Only the terminal roles (`superadmin`, `trader`, `tenant_user`) with a workspace reach these routes; a tenant login gets 403. Start, verify and renew are limited to 10 of each per user in 10 minutes in the app (per instance, a burst guard) and by the broker service (binding, section 6).

Console and tenant portal pages are server components. They read through server-only modules in `src/lib/server/` with the service role, after `requireRole`. They write with server actions that check the role again and append an `audit_events` row.

### Type changes (`src/lib/types.ts`)

- `BrokerConnection` gains `id`, `method` (`"ibkr_gateway" | "ibkr_oauth" | "etrade_oauth1"`), `environment` (`"production" | "sandbox" | "paper"`) and `statusDetail?`.
- `ConnectionStatus` becomes `"connected" | "expiring" | "pending" | "expired" | "error" | "disconnected"`. DB `active` maps to `connected`, or to `expiring` when `session_expires_at` is under 2 hours away.
- `BrokerAccount.id` is `broker_accounts.id` (uuid). `masked` is `display_number`.
- `Position` gains optional `marketValue`, `unrealizedPnl`, `currency` and `secType`.

## 5. Service JWT (app to broker service)

HS256, signed with `BROKER_SERVICE_SECRET`, sent as `Authorization: Bearer <jwt>`.
Header `{"alg":"HS256","typ":"JWT"}`. Claims:
`{ "iss": "nasscord-app", "aud": "nasscord-broker", "sub": "<user uuid>", "wid": "<workspace uuid or null>", "role": "<role>", "iat": <s>, "exp": <iat + 60> }`.
The service rejects a token that is expired, issued more than 120 s in the future, or has the wrong `aud` or `iss`. Both sides implement it with `node:crypto` (no JWT library). Compare signatures with `timingSafeEqual`.

## 6. Broker service API

JSON over HTTP on `API_PORT`. Everything under `/v1` needs the service JWT. Every connection id is checked against `wid` before use, except that `superadmin` may read `/v1/health`.

| Method and path | Body | Returns |
|---|---|---|
| `GET /health` | | `{ ok, version, uptimeSec }` (no auth: liveness only, so nobody outside can watch the gateway slots) |
| `GET /v1/health` | | counts of connections by broker and status, running gateways and free slots (superadmin only) |
| `POST /v1/etrade/start` | `{ environment, consumerKey, consumerSecret }` | `{ connectionId, authorizeUrl }` |
| `POST /v1/etrade/verify` | `{ connectionId, verifier }` | `{ connection }` |
| `POST /v1/ibkr/start` | `{ environment }` | `{ connectionId, loginUrl }` |
| `POST /v1/ibkr/:id/ticket` | | `{ loginUrl }` with a fresh one-time ticket (400 for an E*TRADE connection, 404 for another workspace's, 409 `no_gateway` or `disconnected`). See section 7 |
| `GET /v1/connections/:id` | | `{ connection }` |
| `POST /v1/connections/:id/renew` | | `{ connection, loginUrl? }` |
| `DELETE /v1/connections/:id` | | `{ ok: true }` |
| `GET /v1/portfolio` | | `{ accounts: [{ accountId, netLiq?, buyingPower?, cash?, dayPnl?, currency }], positions: Position[], errors: [{ connectionId, message }] }` (a value the broker did not report is left out, never sent as 0) |
| `GET /v1/orders` | | `{ orders: Order[], errors }` |
| `GET /v1/executions` | | `{ executions: Execution[], errors }` |

`connection` in these responses: `{ id, brokerId, method, environment, status, statusDetail, sessionExpiresAt, lastOkAt, accounts: [{ id, label, displayNumber, type, included }] }`, with `status` as stored in the DB. The app maps it to `BrokerConnection`.

Only `included` accounts feed `/v1/portfolio`, `/v1/orders` and `/v1/executions`. The service keeps a per-connection cache (5 s) so many tabs polling cost one broker call. It rate-limits per IBKR username (8 req/s), per E*TRADE connection (2 req/s per module) and globally per process. Connect steps are limited per user: 20 starts and renews in 10 minutes, 20 verifies, 60 login links; and at most 60 new connections a minute for the whole process (429 with `Retry-After`). At most half the gateway slots may wait for an unfinished login (503 `too_many_pending`). It writes `audit_events` for start, verify, renew and disconnect; its own system events (expiries, gateway restarts and exits) carry the connection's `workspace_id`.

Secrets (`broker_secrets`): AES-256-GCM, a random 12-byte IV, the connection id as AAD, base64 fields, `key_version`. The plaintext is JSON:
- E*TRADE: `{ consumerKey, consumerSecret, requestToken?, requestSecret?, accessToken?, accessSecret? }`
- IBKR gateway: nothing secret is stored. The login happens on IBKR's own page and the session lives in the gateway process.

## 7. IBKR (Client Portal Gateway, one process per connection)

- The service spawns `java` directly (no Docker): classpath `<bundle>/root`, `<bundle>/dist/ibgroup.web.core.iblink.router.clientportal.gw.jar` and `<bundle>/build/lib/runtime/*`, main class `ibgroup.web.core.clientportal.gw.GatewayStart`, `--conf <runtime>/slot-<port>/conf.yaml`. The conf is rendered from the bundle's `root/conf.yaml` with `listenPort: <slot>`, `listenSsl: false`, and `ips.allow` limited to `127.0.0.1`.
- Slots come from `IBKR_GATEWAY_PORTS`. One slot per connection, released on disconnect, as soon as a login window ends without a login, 30 minutes after a logged-in session expired, or when the process exits. The JVM gets a minimal environment, never the service's secrets.
- Opening the login, tied to the signed-in user. The browser never receives a login link from the broker service: the service's `loginUrl` from start and renew stays on the server (`POST /api/broker/ibkr/start` answers only `connectionId`, and renew answers `needsLogin` for IBKR). The connect dialog and Reconnect open the app's own route in a new tab:
  - `GET /api/broker/ibkr/login/[id]` (app, Node runtime) only answers a navigation that started on the app itself: when the browser sends `Sec-Fetch-Site` and it is not `same-origin` (a link in an email, another site, the address bar), it answers a page that says to open the login from Brokers. It then checks the Supabase session and the member row, and that connection `id` belongs to the member's workspace (signed out: `/login?next=` back to this route). It then calls the service with the member's service JWT, and answers `303` to the `loginUrl` it gets back (`Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`). When the login cannot be opened it answers a short page with the reason and a link to `/app/brokers`.
  - `POST /v1/ibkr/:id/ticket` (service, service JWT) runs the same workspace check as every `/v1/connections/:id` route (another workspace's connection is a 404), refuses an E*TRADE connection (400), and answers `{ loginUrl }` with a fresh ticket while the connection's gateway is running. It starts nothing: without a running gateway it answers 409 (`no_gateway`, "Press Reconnect"), and 409 (`disconnected`) after a disconnect. Every link is audited as `broker.ibkr.login_link`.
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

## 8. E*TRADE (OAuth 1.0a with the user's own consumer key)

- An individual E*TRADE key only works for the account of the person who owns it. Each user creates a key on developer.etrade.com and pastes the consumer key and secret into Nasscord, choosing Production or Sandbox.
- `GET https://api.etrade.com/oauth/request_token` with `oauth_callback=oob`, HMAC-SHA1. The request token lives 5 minutes.
- The user opens `https://us.etrade.com/e/t/etws/authorize?key=<consumerKey>&token=<requestToken>`, approves, and copies the verification code back into Nasscord.
- `GET https://api.etrade.com/oauth/access_token` with the request token and `oauth_verifier`. The access token and secret are stored encrypted.
- API base: `https://api.etrade.com` for production, `https://apisb.etrade.com` for sandbox. Use `accountIdKey` in every path.
- Tokens end at midnight US Eastern and go inactive after 2 hours idle. Renewal (`/oauth/renew_access_token`) works the same day only. At 00:00 ET the service marks the connection `expired` with the detail "E*TRADE ends every session at midnight Eastern. Reconnect to continue."
- Rate limit: treat an HTTP 400 with an HTML body as rate limited and back off. Revoke the token on disconnect (`/oauth/revoke_access_token`).
- Reads: `/v1/accounts/list`, `/v1/accounts/{key}/balance?instType=BROKERAGE&realTimeNAV=true`, `/v1/accounts/{key}/portfolio`, `/v1/accounts/{key}/orders`.

## 9. Demo removal

- `src/lib/mock/` is deleted. Nothing imports demo data, and `DEMO_NOW` is replaced by the real clock.
- A page with no real source yet shows `EmptyState` with a plain sentence about what is missing. No fake numbers appear. Today that covers TradeScope alerts, the option ideas, the scanner and ticker prices (no market data feed), analysis history, billing, revenue, payouts, the referral funnel and plan pricing.
- `DemoFlag` is removed wherever the page now shows the user's own data.
- Only IBKR and E*TRADE are connectable. Every other broker in `src/lib/brokers.ts` shows "Not available yet" in the connect flows, and the public pages say plainly which brokers work today.
- The marketing pages may keep illustrations of the product. Those are static example data inside the marketing components, labelled as examples, and never read from `src/lib/api`.
- Public forms really save: the tenant application goes to `tenant_applications`, and the broker request goes to `broker_requests`.
- Order entry is off in this release: the ticket shows why, and the place button is disabled.
