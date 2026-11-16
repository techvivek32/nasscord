# Setting up Nasscord

This guide takes you from nothing to a working Nasscord: a Supabase project with the schema, the app running locally and in production, you signed in as the super admin, the broker service answering, and every broker beyond IBKR and E\*TRADE switched on as its approval arrives (step 13). Follow the steps in order. The contract behind every value is `docs/real-backend.md`.

The live app is `https://nasscord.com`. It runs on the VPS next to the broker service; Vercel (`nasscord-phi.vercel.app`) was the first host, and the Vercel notes below still apply if you deploy there.

What you need:

- A Supabase account (supabase.com).
- Node 24 and this repo, with `npm install` already done.
- For broker connections: Java 17 or newer and the IBKR Client Portal Gateway (step 9), and for production a US VPS with a domain you control (step 11).
- For the other brokers: the accounts and approvals in step 13. Start those early; they take days to weeks.

## 1. Create the Supabase project

1. On supabase.com, choose **New project**. Use a new project, not NOVA's.
2. Pick a US region (for example East US) and set a strong database password. Save it in your password manager.
3. Under the security options, keep the **Data API** enabled and exposed on the `public` schema (the default). Do not choose "connection string only" or a dedicated API schema: the app (`supabase-js`) and the broker service (PostgREST at `/rest/v1`) read and write every table through the Data API, and every table is in `public`.
4. Wait until the project says it is ready.

## 2. Run the migrations

1. Open **SQL Editor**, then **New query**.
2. Open `supabase/migrations/20261103120000_init.sql` from this repo, copy all of it, paste it into the editor and press **Run**.
3. Do the same with `supabase/migrations/20261116120000_more_brokers.sql`. It adds the other brokers: their ids and connect methods, two columns on `broker_connections` (`data_as_of`, `scope`) plus `external_ref`, which the app never reads, and two tables only the service role reads.
4. Open **Table Editor**. You should see 12 tables: `tenants`, `workspaces`, `members`, `user_settings`, `broker_connections`, `broker_accounts`, `broker_secrets`, `broker_oauth_pending`, `broker_aggregator_users`, `tenant_applications`, `broker_requests`, `audit_events`.

Run each migration once, in that order. Running the init migration again fails because its tables already exist, which is harmless; the more-brokers migration can be run again safely, since every statement in it checks first and it changes nothing the second time. On a project that already runs Nasscord, run only the new migration, and run it **before** deploying the new broker service and app (step 13.2).

## 3. Auth settings

1. **Authentication, Sign In / Providers, Email**: keep Email enabled and turn **Confirm email** on. Leave it on: with it off, Supabase marks every address confirmed at once, and the app then refuses to make anyone super admin automatically (step 7).
2. **Authentication, URL Configuration**:
   - **Site URL**: the public address of the app, `https://nasscord.com`. It must match `NEXT_PUBLIC_SITE_URL`.
   - **Redirect URLs**: add `http://localhost:3000/**` and `https://nasscord.com/**` (and any other address you serve the app on, such as `https://nasscord-phi.vercel.app/**`).
3. **Project Settings, JWT Keys**: make sure the current signing key is an asymmetric key (ECC P-256 or RSA). New projects use one by default. If the page shows only a "Legacy JWT secret", create a new signing key and rotate to it. With an asymmetric key the app verifies sessions locally instead of calling Supabase on every request.
4. **Authentication, Emails, SMTP Settings**: Supabase's built-in sender only allows a few emails per hour and is meant for testing. Before real users sign up, set up your own SMTP provider here.

## 4. The two email templates

Open **Authentication, Emails, Templates**. Change the link in two templates so it points at the app's `/auth/confirm` route. Keep the rest of the text as you like.

**Confirm signup**:

```html
<h2>Confirm your email</h2>
<p>Open this link to confirm your address and finish setting up Nasscord:</p>
<p><a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/signup">Confirm my email</a></p>
```

**Reset password**:

```html
<h2>Reset your password</h2>
<p>Open this link to choose a new password for Nasscord:</p>
<p><a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/login/reset">Choose a new password</a></p>
```

Save each template. Links work once and expire after an hour (Authentication, Providers, Email, "Email OTP expiration").

## 5. Copy the keys

Open **Project Settings, API Keys** (and **Data API** for the URL). You need three values:

| Value in Supabase | Env var |
|---|---|
| Project URL | `NEXT_PUBLIC_SUPABASE_URL` |
| anon / publishable key | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| service_role / secret key | `SUPABASE_SERVICE_ROLE_KEY` |

The service role key bypasses all row level security. Keep it on the server only: never paste it into a `NEXT_PUBLIC_*` variable, a chat or a screenshot.

## 6. Environment variables

### Local

Copy `.env.example` to `.env.local` and fill it in:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service role key>
NEXT_PUBLIC_SITE_URL=http://localhost:3000
NEXT_PUBLIC_APP_DOMAIN=nasscord.com
BROKER_SERVICE_URL=http://localhost:8710
BROKER_SERVICE_SECRET=<48 random bytes, see below>
NASSCORD_SUPERADMIN_EMAILS=you@yourdomain.com
```

Generate the broker secret once and use the same value in the broker service:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Then run `npm run dev` and open http://localhost:3000. While a value is missing, the public pages still work and the sign-in pages say "Supabase is not configured".

For Supabase's Site URL during local testing you can temporarily set `http://localhost:3000`, or keep the production URL and open the email links on the deployed app.

### Production

The production app needs the same eight names with production values. On the VPS they live in the app's own env file (root-only, read at build and start); on Vercel they go under **Settings, Environment Variables** for **Production**.

- `NEXT_PUBLIC_SITE_URL=https://nasscord.com`. This is the canonical host: email links land there, and every broker that signs a user in returns there (step 13.1). It must be the same origin as the broker service's `OAUTH_CALLBACK_BASE`, and must answer `/api/broker/callback/*` itself with no redirect (`www` may redirect to it, not the other way round).
- `BROKER_SERVICE_URL=http://127.0.0.1:8710` when the app runs on the broker service's VPS, or `https://broker.nasscord.com` when it runs elsewhere (step 11).

Rebuild after changing a `NEXT_PUBLIC_*` value: those values are built into the pages.

`NEXT_PUBLIC_APP_DOMAIN` is the apex domain that workspace addresses are shown under (`<slug>.nasscord.com`). Those addresses only open once you set them up (step 12); until then everyone uses the main address in `NEXT_PUBLIC_SITE_URL`.

## 7. Become the super admin

1. Put your own email in `NASSCORD_SUPERADMIN_EMAILS` (step 6) before you sign up. Several addresses are separated by commas.
2. Open `/signup` and create your account.
3. Open the confirmation email and click the link. It signs you in and brings you back to `/signup` at step 2.
4. Create your workspace. Because your email is on the list and you confirmed it through the emailed link, your member row gets the role `superadmin`. Finish the remaining steps.
5. Check it: **Table Editor, members** shows your row with `role = superadmin`, and `/admin` opens the console.

There is no other way to become super admin from the app. Anyone else who signs up becomes a `trader`, or a `tenant_user` when they enter an active tenant's code. A listed address is only promoted when Supabase actually emailed a confirmation link for it, so an account made in the dashboard with "Auto confirm" (or any signup while Confirm email is off) stays a trader: use the SQL below for it.

If you signed up before setting the variable, fix it in **SQL Editor**:

```sql
update public.members set role = 'superadmin', tenant_id = null where email = 'you@yourdomain.com';
update auth.users
   set raw_app_meta_data = raw_app_meta_data || '{"role": "superadmin", "tenant_id": null}'::jsonb
 where email = 'you@yourdomain.com';
```

Then open `/signup`: it copies the role from your member row into your session and sends you to `/admin`. (The layouts read the member row on every request, so the console opens either way; the session copy only matters to the first redirect.)

## 8. Optional: a first tenant

Tenants are distributors. A trader who types a tenant's code at signup joins that tenant.

1. If the tenant should have its own portal login, that person signs up first at `/signup` with their own email, confirms it, and finishes the workspace step. (Signup always creates a trading workspace.)
2. In the console, open **Tenants** and press **Create tenant**. Enter the name, slug, referral code and commission, and the person's email as **Owner email** (leave it empty for a tenant without a login).
3. Their login becomes the tenant's: role `tenant`, the tenant portal only. They leave the trading workspace they made at signup, which stays in the console's Traders list without members. Creating the tenant is refused while that workspace still has a broker connected: they disconnect every broker on their Brokers page first, so no connection or stored E*TRADE key is left behind.

Codes are 3 to 24 upper case letters, numbers or hyphens. Applications from the public Tenants page appear on the same console page; approving one only records the decision, then **Create tenant** next to it opens the same form.

Fallback without the console (no owner login), in **SQL Editor**:

```sql
insert into public.tenants (slug, name, referral_code, commission_pct)
values ('acme-capital', 'Acme Capital', 'ACME', 25);
```

To support a tenant, the super admin presses **View portal** next to it on the console's Tenants page.

## 9. Run the broker service locally

The broker service (`services/broker`) holds the token key and the IBKR gateways and makes every call to IBKR and E*TRADE. The app never talks to a broker directly.

1. Install Java 17 or newer (`java -version` should work).
2. Download the IBKR Client Portal Gateway (`clientportal.gw.zip`) from IBKR's API pages and unzip it, for example to `C:\ibkr\clientportal.gw`. The folder contains `dist/`, `build/lib/runtime/` and `root/`.
3. Create `services/broker/.env`:

   ```bash
   API_PORT=8710
   LOGIN_PORT=8711
   PUBLIC_LOGIN_URL=http://localhost:8711
   SUPABASE_URL=https://<project-ref>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<service role key>
   BROKER_SERVICE_SECRET=<same value as the app>
   BROKER_TOKEN_KEY=<base64 of 32 random bytes, see below>
   BROKER_TOKEN_KEY_VERSION=1
   IBKR_GATEWAY_BUNDLE=C:\ibkr\clientportal.gw
   IBKR_GATEWAY_RUNTIME=C:\ibkr\runtime
   IBKR_GATEWAY_PORTS=7200-7249
   JAVA_BIN=java
   IBKR_GATEWAY_XMX=256m
   ETRADE_ALLOW_SANDBOX=true
   NASSCORD_APP_URL=http://localhost:3000
   ```

   `NASSCORD_APP_URL` is where the "Back to Nasscord" link on the IBKR login pages points. `NODE_ENV` is not set locally, so the service runs in development mode: `PUBLIC_LOGIN_URL` may be `http://`, and sandbox E*TRADE keys are accepted unless `ETRADE_ALLOW_SANDBOX=false`. The optional variables (`API_HOST`, `LOGIN_HOST`, `LOG_LEVEL`, `BROKER_GLOBAL_RPS`, `BROKER_TOKEN_KEYS_PREVIOUS`, the connect limits and `IBKR_MAX_PENDING_LOGINS`) and their defaults are in the Environment table of `services/broker/README.md`.

   Generate the token key once and keep a copy in your password manager. Losing it makes every stored E*TRADE credential unreadable:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

4. Start it: `cd services/broker` and `npm start`.
5. Check it: http://localhost:8710/health answers `{ "ok": true, ... }`.
6. In the app's `.env.local`, `BROKER_SERVICE_URL=http://localhost:8710`. Restart `npm run dev`.

`BROKER_TOKEN_KEY` belongs to the broker service only. It never goes into the app's environment.

Locally, broker sign-ins (OAuth) and SnapTrade return to `NASSCORD_APP_URL` (or `http://localhost:3000`) unless `OAUTH_CALLBACK_BASE` says otherwise. No real broker accepts a localhost callback, so test those against the local fakes described in `services/broker/README.md`, or on the VPS.

## 10. Connect a test broker

- **IBKR**: choose Interactive Brokers, Paper. The IBKR login page opens; sign in with your paper username and second factor. IBKR allows one session per username, so opening TWS or the IBKR mobile app with the same username can end Nasscord's session. A separate IBKR username for Nasscord avoids that.
- **E\*TRADE**: on developer.etrade.com, create an individual **Production** key for your own account. In the terminal's Brokers page, choose E\*TRADE, paste the consumer key and secret, open E\*TRADE, approve, and paste the verification code. E\*TRADE ends every session at midnight Eastern, so you reconnect once a day. A sandbox key returns E\*TRADE's sample accounts, so it is for a developer machine only: the dialog offers it only with `NEXT_PUBLIC_ETRADE_SANDBOX=1`, and a broker service with `NODE_ENV=production` refuses it whatever the settings say.
- **Alpaca**: open a free Paper Only account at app.alpaca.markets, generate an API key, and connect it on the Brokers page. It shows as Paper. Step 13 has every other broker.

The first release is read-only: balances, positions, orders and executions. Order entry stays off.

## 11. Deploy the broker service on a VPS

The full commands are in `services/broker/README.md`, "Deploy on the VPS". In short:

1. **The VPS**: one Ubuntu 24.04 (or similar) server **in the US**. IBKR's login page checks the visitor's location (`ip2loc=US`) and the gateway runs on this server. Run **one instance only**: the IBKR sessions live in the service's memory, so two copies would each hold half of them. Open only ports 80 and 443 to the internet; the API (8710), the login host (8711) and the gateway slots (7200 to 7249) stay on localhost behind Caddy.
2. **DNS**: A records pointing at the VPS for `ibkr-login.<domain>` (the IBKR login host, opened in users' browsers) and, only when the app runs on another host, `broker.<domain>` (the JSON API, called only by the app). When the app runs on this VPS it calls the API on `http://127.0.0.1:8710` and the API stays private.
3. **Software**: `sudo apt install -y openjdk-17-jre-headless caddy`, plus Node 24 (NodeSource or the official tarball). Check `java -version` and `node -v`.
4. **Code and gateway bundle**: copy `services/broker/` to `/opt/nasscord-broker/` (without `.env` and `runtime/`), and the unzipped IBKR Client Portal Gateway to `/opt/nasscord-broker/vendor/clientportal.gw/` (the default `IBKR_GATEWAY_BUNDLE`). Create the `nasscord` system user and make the folder readable by it only, as the README shows.
5. **Configuration**: create `/etc/nasscord-broker.env` with `chmod 600`, owned by root, as `KEY=value` lines (no quotes, no `export`). Use the step 9 variables with production values:
   - `PUBLIC_LOGIN_URL=https://ibkr-login.<domain>` (https is required in production)
   - `NASSCORD_APP_URL=https://nasscord.com`
   - `OAUTH_CALLBACK_BASE=https://nasscord.com` (step 13.1; the same origin as the app's `NEXT_PUBLIC_SITE_URL`)
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `BROKER_SERVICE_SECRET` (the same value as the app), `BROKER_TOKEN_KEY`, `BROKER_TOKEN_KEY_VERSION`
   - `ETRADE_ALLOW_SANDBOX=false`. The systemd unit sets `NODE_ENV=production`, where sample-data environments are refused whatever this says (E\*TRADE sandbox keys, `TASTYTRADE_ENV=cert`, `WEBULL_ENV=sandbox`, `BROKER_URL_OVERRIDES`).
   - Each broker's credentials and `BROKER_AUDIENCE` only as step 13 says.
   - Leave out `IBKR_GATEWAY_BUNDLE`, `IBKR_GATEWAY_RUNTIME` and `JAVA_BIN` to use the defaults (the unit puts the runtime folder in `/var/lib/nasscord-broker/runtime`).
6. **Service**: copy `deploy/nasscord-broker.service` to `/etc/systemd/system/`, then `sudo systemctl daemon-reload && sudo systemctl enable --now nasscord-broker`. Check it with `curl -s http://127.0.0.1:8710/health` (it answers `{ "ok": true, ... }`) and `journalctl -u nasscord-broker -f`. Exit code 78 in the log means a bad configuration; the log names the variable.
7. **TLS**: `deploy/Caddyfile` holds the Caddy blocks this VPS needs; it is not a whole file to copy over a running Caddy.
   - **The app already runs on this VPS** (nasscord.com today): do not copy the file over `/etc/caddy/Caddyfile`, which also serves `nasscord.com` and `www` and would go offline. Merge instead: put the file's global options block (the `log default` filter) at the very top of `/etc/caddy/Caddyfile`, or its `log default { ... }` lines into the global block already there, and add the `ibkr-login.<domain>` block if it is missing.
   - **A fresh VPS**: copy the file to `/etc/caddy/Caddyfile` and uncomment the blocks your layout needs: the app's `<domain>` and `www` blocks when the app runs here, the `broker.<domain>` block only when the app runs on another host.
   - Set your domain in it (or `NASSCORD_DOMAIN` in Caddy's environment), then `sudo caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile && sudo systemctl reload caddy`. A failed validation leaves the running configuration as it was. Caddy gets the certificates itself once DNS points at the VPS. If you publish the API, check `https://broker.<domain>/health` from your own computer.
8. **The app**: set `BROKER_SERVICE_URL` (`http://127.0.0.1:8710` on the same VPS, `https://broker.<domain>` from elsewhere) and the same `BROKER_SERVICE_SECRET`, then rebuild and restart it. The console's Health page shows the service as answering.

Run one broker service only. Keep the `log default` filter at the top of `/etc/caddy/Caddyfile` and add no `log` directive to a site block: broker sign-ins come back with login codes in the address (step 13.1). Back up `BROKER_TOKEN_KEY` somewhere other than the VPS.

## 12. Optional: workspace addresses and white-label domains

Every workspace gets an address, `<slug>.<NEXT_PUBLIC_APP_DOMAIN>`, and a white-label tenant can have its own domain. Both serve the same app and always show the signed-in user's own workspace; a white-label domain also shows its tenant's brand. Nothing serves them until you set them up; until then the workspace address that signup, the terminal and the console show is reserved for the workspace but does not open:

- **Workspace addresses**: in Vercel, add the domain `*.<domain>` to the project (Vercel needs its nameservers on the domain for a wildcard). In Supabase, **Authentication, URL Configuration**, add `https://*.<domain>/**` to the Redirect URLs. Sign-in is per address: the session cookie belongs to the host, so someone who opens their workspace address signs in there once.
- **A white-label domain** (for example `trade.acmecapital.com`): add it to the Vercel project, have the tenant create the CNAME record Vercel shows at their DNS provider, add `https://trade.acmecapital.com/**` to Supabase's Redirect URLs, then enter the domain in the tenant's branding (console, White-label). The domain shows the tenant's brand once white-label is granted.

Email links always use `NEXT_PUBLIC_SITE_URL`, so confirmation and reset links land on the main address. Broker sign-ins do the same: whatever address a trader connects from, the broker returns to `https://nasscord.com` and only a one-time ticket goes on to the workspace or white-label address. Nothing about these addresses is registered with a broker.

## 13. Connect more brokers

IBKR and E\*TRADE need nothing new. Every other broker needs one of three things:

- nothing from you: Alpaca, where each user pastes a key of their own account;
- your own developer account, for testing with your own money: Schwab, TradeStation, Tradier and tastytrade;
- an approval of Nasscord as a business: SnapTrade production, Alpaca Connect, the Tradier partnership, tastytrade's
  third-party verification, Webull Connect, Schwab Commercial and the TradeStation partnership.

The code for every one of them is already in the broker service. A way of connecting opens to users only when you
open it (step 13.3), and you open it only once the broker's approval is in writing. Approvals take days to weeks and
none publishes a timeline, so start them all now, in parallel. Of these, only SnapTrade publishes a price; the
partner terms of the others are unknown until you apply.

### 13.1 Freeze the return address (first, before you register anything)

Every broker that signs a user in on its own page, and SnapTrade's connection page, sends the user back to one fixed
address on the canonical host, `https://nasscord.com` (`www` redirects to it). Register these exactly:

| Where | Callback URL |
|---|---|
| Alpaca Connect app | `https://nasscord.com/api/broker/callback/alpaca` |
| Schwab app (yours, and later the Commercial app) | `https://nasscord.com/api/broker/callback/schwab` |
| TradeStation key | `https://nasscord.com/api/broker/callback/tradestation` |
| Tradier partner app | `https://nasscord.com/api/broker/callback/tradier` |
| tastytrade OAuth client | `https://nasscord.com/api/broker/callback/tastytrade` |
| Webull Connect app | `https://nasscord.com/api/broker/callback/webull` |
| SnapTrade (redirect after the connection page) | `https://nasscord.com/api/broker/callback/snaptrade` |

- Never change them. A new address means every Schwab app and every TradeStation key has to be approved again.
- `nasscord.com` must answer `/api/broker/callback/*` itself, over https, with no redirect. Workspace addresses and
  white-label domains are never registered with a broker: the login hops through `nasscord.com` and only a one-time
  ticket travels on to the user's own address.
- Never log a query string. These callbacks carry login codes in the address. Two settings in Caddy keep them out
  of its log, and both must be in place on the VPS before you register the first address (step 11.7):
  - No access log: Caddy writes one only for a site block with a `log` directive, so add none, to the
    `nasscord.com` block or the broker blocks.
  - The `log default` filter at the top of `services/broker/deploy/Caddyfile`. Caddy's error log is always on, and
    when a request fails (a 502 while the app restarts, which happens on every deploy) it records the full address.
    The filter cuts the query string off every address Caddy logs and drops the Referer header.
- The console's **Brokers** page lists the same URLs, as the broker service builds them, with Copy buttons.

### 13.2 Deploy the release with more brokers

Order matters: the migration, then the broker service, then the app.

1. **Migration.** In Supabase, **SQL Editor**, run `supabase/migrations/20261116120000_more_brokers.sql` once (step 2).
   Every existing IBKR and E\*TRADE row passes its new checks.
2. **Broker service.** Deploy the new code and add to `/etc/nasscord-broker.env`:

   ```bash
   OAUTH_CALLBACK_BASE=https://nasscord.com
   ```

   Then `sudo systemctl restart nasscord-broker`. A configuration mistake stops it with exit code 78 and the
   variable's name in `journalctl -u nasscord-broker`. Credentials of each broker are added later, as approvals
   arrive (13.4); a broker without them shows as "Not set up".

   In the same visit, add the `log default` filter to `/etc/caddy/Caddyfile` if it is not there yet (step 11.7,
   merge rather than copy), validate and reload Caddy.
3. **App.** Deploy with `NEXT_PUBLIC_SITE_URL=https://nasscord.com`, the same origin as `OAUTH_CALLBACK_BASE`. If the
   two differ, the connect dialogs say "Broker logins are not set up correctly on this server".
4. **Check.** Open the console, **Brokers**. **Ways to connect** shows each way with Ready, Only you, or Not set up
   and the setting it misses; **Registry** shows who may connect each broker. The public `/brokers` page shows the same
   availability within 5 minutes.

### 13.3 Who may connect what (BROKER_AUDIENCE)

Each way of connecting has a gate on the broker service: `all` (every trader), `superadmin` (only you) or `off`.

| Gate key | Default | Open it to everyone when |
|---|---|---|
| `ibkr_gateway`, `etrade_oauth1`, `alpaca_key` | `all` | already open |
| `snaptrade` | `all`, but only once the SnapTrade keys are set | SnapTrade production is approved and a plan is chosen. Set `snaptrade=superadmin` while you test on the free Build plan |
| `schwab_oauth.user` (each user's own Schwab app) | `superadmin` | Schwab agrees in writing |
| `schwab_oauth.platform` (Nasscord's Commercial app) | `superadmin` | Schwab approves the Commercial app and you have tested it |
| `tradestation_oauth.user` (each user's own key) | `superadmin` | TradeStation agrees in writing |
| `tradestation_oauth.platform` | `superadmin` | TradeStation accepts Nasscord as a partner |
| `tradier_token` (a personal token) | `superadmin` | never: Tradier's API is for personal use unless you are a partner |
| `tradier_oauth` | `superadmin` | the partnership is signed and the consent exhibit is in the dialog |
| `tastytrade_oauth` | `superadmin` | tastytrade's verification passes and its written answers are in |
| `alpaca_oauth` | `superadmin` | Alpaca approves the Connect app for other users' accounts |
| `webull_oauth` | `superadmin` | Webull approves Connect after its sandbox testing |

To change one, set `BROKER_AUDIENCE` in `/etc/nasscord-broker.env`, comma-separated, for example
`BROKER_AUDIENCE=snaptrade=superadmin,schwab_oauth.platform=all`, and restart the broker service. The app needs no
redeploy: the connect dialogs follow within a minute and the public pages within 5 minutes. Connections made before a
gate closed keep reading; only new logins are refused.

### 13.4 Broker by broker

**Alpaca: open to everyone now.**

- Users need nothing from you. They paste the API key and secret of one Alpaca account, Live or one of their Paper
  accounts. Alpaca keys can trade; Nasscord reads only (every other call is refused in code), and the dialog says so.
- To test: open a free Paper Only account at <https://app.alpaca.markets> (an email is enough), generate a key and
  connect it on your own Brokers page. Resetting a paper account changes its keys: the connection then asks for the
  new key.
- In parallel, register Alpaca Connect, so users can sign in instead of pasting a key: at
  <https://app.alpaca.markets/connect>, **My Developed Apps**, **Submit Your App**. Say that Nasscord is a paid
  commercial app, and enter the redirect URI from 13.1. Alpaca issues the Client ID and secret at once: set
  `ALPACA_CLIENT_ID` and `ALPACA_CLIENT_SECRET`. Until Alpaca approves, only paper accounts and your own live account
  can sign in. Ask Alpaca in writing whether the approval for a commercial app also covers other users' paper
  accounts. No fee is published.

**SnapTrade: Fidelity, Robinhood, Public and Moomoo, plus Webull, Schwab (read only) and tastytrade.**

1. Create a SnapTrade account at <https://snaptrade.com> and take the free **Build** keys. They connect real accounts,
   up to 5 brokerage connections, for development and testing. Set `SNAPTRADE_CLIENT_ID`, `SNAPTRADE_CONSUMER_KEY` and
   `BROKER_AUDIENCE=snaptrade=superadmin`, so only you connect while you test.
2. Submit the **Production Access Application** in the SnapTrade dashboard (a KYC review; no published time) and fill
   in the app profile. Robinhood, Public, Moomoo, Webull and tastytrade go live when production is approved. Fidelity
   then approves your profile in about 2 business days, and Schwab (read only) in about a week.
3. Choose the plan. **Launch** is $100 a month plus, per connected user a month, $2 for real-time data or $1 for daily
   data (read only; a manual refresh costs $0.05). A connected user counts once a month however many brokers they
   link. Set `SNAPTRADE_PLAN=realtime` or `daily` to match what you pay for.
4. Enter the redirect `https://nasscord.com/api/broker/callback/snaptrade` wherever the dashboard asks for one, and
   check whether it keeps an allowlist of redirect addresses.
5. Accept SnapTrade's Compliance Policy (<https://snaptrade.com/compliance-policy>): trade ideas and signals must be
   pull-based (the user asks for them) and every order needs the user's own confirmation. Check TradeScope alerts
   against it before they are switched on.
6. Once production is approved and the plan is chosen: set `SNAPTRADE_BROKERS` to the brokers SnapTrade connects for
   Nasscord, remove `snaptrade=superadmin` from `BROKER_AUDIENCE`, and restart the broker service. The default is
   `fidelity,robinhood,public,moomoo,webull`. Add `tastytrade` as soon as production is approved (it needs no profile
   approval of its own). Leave `fidelity` out until SnapTrade approves its Fidelity profile (about 2 business days),
   and add `schwab` only once its Schwab profile is approved (about a week), so the public pages never list a broker
   that cannot connect yet. On the day production is approved that is, for example,
   `SNAPTRADE_BROKERS=robinhood,public,moomoo,webull,tastytrade`.
7. Optional, later: webhooks make updates arrive sooner. Copy the `broker-hooks` block from
   `services/broker/deploy/Caddyfile` into `/etc/caddy/Caddyfile` without its `#` marks, add its DNS record, validate
   and reload Caddy (step 11.7), and enter `https://broker-hooks.nasscord.com/hooks/snaptrade` as the webhook URL in
   the dashboard.

Vanguard is not offered: SnapTrade would need the user's Vanguard password typed into its page.

**Charles Schwab.**

- For users: read only through SnapTrade once its Schwab profile is approved (above), or Nasscord's own Commercial app
  later.
- For your own account now (gate `schwab_oauth.user`, only you):
  1. You need a Schwab brokerage account. Create a developer profile at <https://developer.schwab.com>; it is a separate
     login from your brokerage login.
  2. Request the API product **Trader API - Individual**.
  3. **Dashboard**, **Apps**, **Create App**: choose **Accounts and Trading Production** and enter
     `https://nasscord.com/api/broker/callback/schwab` exactly.
  4. Wait until the app says **Ready For Use**. "Approved - Pending" is not usable yet; it takes from a day to a few
     weeks.
  5. On your Brokers page, Schwab, **Connect with your own Schwab developer app**: paste the App Key and Secret, sign in
     on Schwab and tick the accounts. Schwab asks for a new login every 7 days; the card warns 48 hours before.
- Ask Schwab in writing whether a hosted app may serve many users' own Individual apps. Schwab defines an Individual
  app as your own app for your own account, so only that written OK opens `schwab_oauth.user=all`.
- Apply for **Trader API - Commercial** on the same portal. It is reviewed case by case and asks about TradeScope's
  signals. On approval: `SCHWAB_CLIENT_ID` and `SCHWAB_CLIENT_SECRET`, test it yourself, then
  `schwab_oauth.platform=all`.

**TradeStation.**

- You need a funded TradeStation account. A new account opened through the API offer (promo code WAPIAFSG) must fund
  at least $10,000.
- Email TradeStation Client Experience at ClientExperience@tradestation.com. Ask for an API key, ask them to add
  `https://nasscord.com/api/broker/callback/tradestation` to its allowed callback URLs, and ask in writing whether a
  personal key may be used through a hosted multi-user app such as Nasscord. The key must be the newer kind (upper and
  lower case letters, no dashes). Nasscord has no paste-the-code fallback: the callback must be on the key.
- Connect it on your own Brokers page (gate `tradestation_oauth.user`, only you). If your key rotates refresh tokens,
  TradeStation asks for a new login every 24 hours and the card shows when.
- Paper (SIM) stays hidden. Set `TRADESTATION_ALLOW_SIM=true` only after a real login shows that SIM holds only your
  own simulated activity.
- For users at scale, submit the partner form at <https://developer.tradestation.com/trading-api/>. On approval:
  `TRADESTATION_CLIENT_ID` and `TRADESTATION_CLIENT_SECRET`, then `tradestation_oauth.platform=all`. No fee is published.
- Nasscord never calls TradeStation's revoke on Disconnect: it would end every token on the key, including other tools.

**Tradier.**

- Your own account now: open a Lite account ($0) at <https://onboarding.tradier.com>, copy the token under **API
  Access**, and connect it on your Brokers page as a personal token (gate `tradier_token`, only you). Tradier's API is
  for personal use unless you are a partner, so this never opens to users.
- For users: apply to become a Tradier partner at <https://tradier.com/platforms/tradepartner> or sales@tradier.com,
  describing Nasscord as a multi-user read-only terminal. Register `https://nasscord.com/api/broker/callback/tradier`
  (Tradier takes one pre-registered address). On approval: `TRADIER_CLIENT_ID` and `TRADIER_CLIENT_SECRET`.
- Ask techsupport@tradier.com to enable refresh tokens, then set `TRADIER_REFRESH_TOKENS=true`. Without them every user
  approves Nasscord again every 24 hours.
- Before `tradier_oauth=all`, replace the consent text in `src/lib/broker-connect/tradier.ts` with the exhibit from
  the partner agreement.
- Ask in writing whether users may paste their own sandbox (paper) tokens; only then set `TRADIER_SANDBOX_TOKENS=true`.

**tastytrade.**

- Turn on two-factor authentication on your tastytrade account (Manage, My Profile, Security).
- Your own account now: my.tastytrade.com, **Manage**, **My Profile**, **API**, **New OAuth client**, with the redirect
  `https://nasscord.com/api/broker/callback/tastytrade` and scope `read`. The client secret is shown once: put it in
  `TASTYTRADE_CLIENT_SECRET` and the id in `TASTYTRADE_CLIENT_ID`. The gate `tastytrade_oauth` stays only you.
- For users: email api.support@tastytrade.com to start the trusted third-party verification. Answer Exhibit A of the
  API Terms (which tastytrade data Nasscord shows, stores, and how it tells users), ask for the prior written approval
  for third-party software (ToS 2(3)(f)) and whether Nasscord counts as an API Hub, and ask in writing how an approved
  integrator may store refresh tokens. Never share a quote-streaming token across users.
- Keep records of API use for 2 years after the agreement ends; tastytrade may audit once a year.
- `TASTYTRADE_ENV=cert` (tastytrade's sample sandbox) is for a developer machine only; the service refuses it in
  production. Keep `TASTYTRADE_API_VERSION` current: tastytrade removes old versions (20250813 goes on or after
  2027-04-12).

**Webull.**

- Until Webull approves Nasscord, Webull connects through SnapTrade.
- Submit the Connect API form at <https://www.webull.com/connect-api/info> as an organization: it needs a legal entity,
  a business email and someone authorized to submit. Enter `https://nasscord.com/api/broker/callback/webull`, ask for a
  read-only scope, and ask whether data calls (not only the token call) must be signed. Contact:
  connect.api@webull-us.com. No fee or timeline is published.
- Webull requires sandbox testing before production. Do it on a developer machine with `WEBULL_ENV=sandbox` and the
  sandbox credentials, never on the VPS (the service refuses it in production).
- After approval: `WEBULL_CLIENT_ID`, `WEBULL_CLIENT_SECRET`, `WEBULL_APP_KEY` and `WEBULL_APP_SECRET` (the app key and
  secret only sign requests). Test it yourself, then `webull_oauth=all`.
- Webull's refresh token lasts 15 days and changes on every refresh. Ask Webull whether the 15 days start again with
  each refresh; until that is confirmed, plan for users approving again every 15 days.

**Not offered:** Vanguard (password typed into SnapTrade), Merrill and Firstrade (only Plaid reaches them, without
orders), Public's personal key (it can place trades), Moomoo's OpenD (a gateway logged in with the user's password).
Plaid's free Trial (10 real connections) is an option later only if Merrill or Firstrade users matter.

### 13.5 The order to switch things on

1. **Now, no code:** start every application in 13.4 in parallel.
2. **Deploy** as in 13.2, with `OAUTH_CALLBACK_BASE` set. Alpaca keys open for everyone at once; test with your Paper
   Only account first.
3. **SnapTrade Build**, only you (`snaptrade=superadmin`): connect your own Fidelity, Robinhood, Public, Moomoo or
   Webull accounts, at most 5.
4. **Your own accounts** through the owner-only ways: your Schwab app, TradeStation key, Tradier token and tastytrade
   app. Check each one (13.6).
5. **Open each way as its approval arrives in writing:** set its credentials, test it yourself, then set its gate to
   `all`. Likely order: SnapTrade (production and a plan), Webull Connect (after the sandbox test), Alpaca Connect,
   Tradier (partner, with refresh tokens), tastytrade (verification), Schwab (Commercial, or Schwab's written OK) and
   TradeStation (partner).
6. **Before users connect a new broker:** update the full privacy policy and terms. Name SnapTrade as a data
   intermediary, list what broker data is stored, and add the Tradier consent exhibit and the tastytrade disclosure.
   The Security page already names SnapTrade and says that keys that can trade are used read-only.

### 13.6 Check each broker on a real account

| Broker | Check |
|---|---|
| Alpaca | A Paper Only key connects as Paper. After you regenerate the key, the card asks for the new one. Disconnect removes it. |
| SnapTrade (Build) | SnapTrade's page opens with the broker already chosen. Finishing returns to Brokers with the accounts; the card shows when the data was updated. Closing the page without finishing leaves no connection. |
| Schwab (your app) | Schwab accepts the callback, the ticked accounts appear, and the card shows the reconnect date 7 days out. |
| TradeStation (your key) | The accounts appear, and Reconnect brings you back to the same connection. |
| Tradier (your token) | Accounts, balances and positions appear; positions are valued from Tradier quotes. |
| tastytrade (your app) | Sign-in works with two-factor on. After Disconnect, also delete the grant at my.tastytrade.com, API. |
| Every dialog | Works at 375 px and 1440 px wide. |

### 13.7 Operations

- Run **one** broker service. Locks, rate limits and token refreshes are in its memory; two copies would lose
  connections whose refresh token rotates (Webull, some TradeStation keys).
- Restart the broker service after any change to its env file. The app needs a rebuild only for `NEXT_PUBLIC_*`
  changes.
- Back up `BROKER_TOKEN_KEY` somewhere other than the VPS. It now protects every stored broker key, token and
  SnapTrade user secret.
- The full reference for the service (routes, secrets, every variable) is `services/broker/README.md`.


## Troubleshooting

| What you see | What to check |
|---|---|
| "Supabase is not configured" | The three Supabase variables are set and the app was restarted (or redeployed on Vercel). |
| The confirmation link lands on sign-in with "That link has expired" | The template link from step 4, the Redirect URLs from step 3, and that the link was opened once only. |
| Signed in, but every page sends you to `/signup` | The workspace step was not finished. Open `/signup` and create the workspace. |
| A role change in the database does not apply | The layouts read the `members` row on every request, so check that row first. The session keeps a copy of the role for the first redirect: open `/signup` to refresh it from the row, or update `raw_app_meta_data` as step 7 shows. |
| Broker pages say the broker service cannot be reached | `BROKER_SERVICE_URL`, the service is running, and `BROKER_SERVICE_SECRET` is the same on both sides. |
| A sandbox E\*TRADE key is refused on the VPS | By design: a sandbox returns E\*TRADE's sample accounts, and the service refuses every sample-data environment with `NODE_ENV=production`. Use a Production key of your own account. |
| "Broker logins are not set up on this server yet" | `NEXT_PUBLIC_SITE_URL` is not the site's own https address. Set `https://nasscord.com` and rebuild the app. |
| "OAUTH_CALLBACK_BASE ... and NEXT_PUBLIC_SITE_URL must name the same address" | Set both to `https://nasscord.com`, restart the broker service and rebuild the app. |
| A broker shows "Not set up on this server: ..." in the console | Set the variables it names in `/etc/nasscord-broker.env` and restart the broker service (step 13.4). |
| A broker connects for you but traders see "Not available yet" | Its gate is `superadmin`, as intended until the broker's approval is in writing. Open it with `BROKER_AUDIENCE` (step 13.3). |
| Schwab says "We are unable to complete your request" | The callback in your Schwab app differs from the one Nasscord shows, character by character, or the app is still "Approved - Pending". |
| The public Brokers page still shows an old status | It asks the broker service at most every 5 minutes. Wait, then reload. |
| "Too many IBKR logins are waiting" | Logins that were started and not finished hold a slot until their 20-minute window ends. Raise `IBKR_MAX_PENDING_LOGINS` (default: half the slots) or add slots if real users hit it. |
| The IBKR login says it only opens from the Brokers page | It was opened from an email, another site or the address bar. Open Brokers in Nasscord and press Connect or Reconnect. |
| Emails stop arriving after a few signups | Supabase's built-in sender limit. Set up SMTP (step 3). |
