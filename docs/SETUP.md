# Setting up Nasscord

This guide takes you from nothing to a working Nasscord: a Supabase project with the schema, the app running locally and on Vercel, you signed in as the super admin, and the broker service answering. Follow the steps in order. The contract behind every value is `docs/real-backend.md`.

What you need:

- A Supabase account (supabase.com).
- Node 24 and this repo, with `npm install` already done.
- For broker connections: Java 17 or newer and the IBKR Client Portal Gateway (step 9), and for production a US VPS with a domain you control (step 11).

## 1. Create the Supabase project

1. On supabase.com, choose **New project**. Use a new project, not NOVA's.
2. Pick a US region (for example East US) and set a strong database password. Save it in your password manager.
3. Under the security options, keep the **Data API** enabled and exposed on the `public` schema (the default). Do not choose "connection string only" or a dedicated API schema: the app (`supabase-js`) and the broker service (PostgREST at `/rest/v1`) read and write every table through the Data API, and every table is in `public`.
4. Wait until the project says it is ready.

## 2. Run the migration

1. Open **SQL Editor**, then **New query**.
2. Open `supabase/migrations/20261103120000_init.sql` from this repo, copy all of it, paste it into the editor and press **Run**.
3. Open **Table Editor**. You should see 10 tables: `tenants`, `workspaces`, `members`, `user_settings`, `broker_connections`, `broker_accounts`, `broker_secrets`, `tenant_applications`, `broker_requests`, `audit_events`.

Run the migration once. Running it again fails because the tables already exist, which is harmless.

## 3. Auth settings

1. **Authentication, Sign In / Providers, Email**: keep Email enabled and turn **Confirm email** on. Leave it on: with it off, Supabase marks every address confirmed at once, and the app then refuses to make anyone super admin automatically (step 7).
2. **Authentication, URL Configuration**:
   - **Site URL**: the public address of the app, for example `https://nasscord-phi.vercel.app`. It must match `NEXT_PUBLIC_SITE_URL`.
   - **Redirect URLs**: add `http://localhost:3000/**` and `https://nasscord-phi.vercel.app/**` (and any custom domain you use).
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

For Supabase's Site URL during local testing you can temporarily set `http://localhost:3000`, or keep the Vercel URL and open the email links on the deployed app.

### Vercel

In the Vercel project, open **Settings, Environment Variables** and add the same eight names for **Production** (and **Preview** if you test previews). Use the production values:

- `NEXT_PUBLIC_SITE_URL=https://nasscord-phi.vercel.app` (or your domain)
- `BROKER_SERVICE_URL=https://broker.nasscord.com` (the broker service's public HTTPS address, step 11)

Redeploy after changing variables: `NEXT_PUBLIC_*` values are built into the pages.

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

`BROKER_TOKEN_KEY` belongs to the broker service only. It never goes into the app or Vercel.

## 10. Connect a test broker

- **E*TRADE**: on developer.etrade.com, create a sandbox key. In the terminal's Brokers page, choose E*TRADE, Sandbox, paste the consumer key and secret, open E*TRADE, approve, and paste the verification code. E*TRADE ends every session at midnight Eastern, so you reconnect once a day. On the VPS a sandbox key needs `ETRADE_ALLOW_SANDBOX=true` (step 11).
- **IBKR**: choose Interactive Brokers, Paper. The IBKR login page opens; sign in with your paper username and second factor. IBKR allows one session per username, so opening TWS or the IBKR mobile app with the same username can end Nasscord's session. A separate IBKR username for Nasscord avoids that.

The first release is read-only: balances, positions, orders and executions. Order entry stays off.

## 11. Deploy the broker service on a VPS

The full commands are in `services/broker/README.md`, "Deploy on the VPS". In short:

1. **The VPS**: one Ubuntu 24.04 (or similar) server **in the US**. IBKR's login page checks the visitor's location (`ip2loc=US`) and the gateway runs on this server. Run **one instance only**: the IBKR sessions live in the service's memory, so two copies would each hold half of them. Open only ports 80 and 443 to the internet; the API (8710), the login host (8711) and the gateway slots (7200 to 7249) stay on localhost behind Caddy.
2. **DNS**: two A records pointing at the VPS, `broker.<domain>` (the JSON API, called only by the app) and `ibkr-login.<domain>` (the IBKR login host, opened in users' browsers).
3. **Software**: `sudo apt install -y openjdk-17-jre-headless caddy`, plus Node 24 (NodeSource or the official tarball). Check `java -version` and `node -v`.
4. **Code and gateway bundle**: copy `services/broker/` to `/opt/nasscord-broker/` (without `.env` and `runtime/`), and the unzipped IBKR Client Portal Gateway to `/opt/nasscord-broker/vendor/clientportal.gw/` (the default `IBKR_GATEWAY_BUNDLE`). Create the `nasscord` system user and make the folder readable by it only, as the README shows.
5. **Configuration**: create `/etc/nasscord-broker.env` with `chmod 600`, owned by root, as `KEY=value` lines (no quotes, no `export`). Use the step 9 variables with production values:
   - `PUBLIC_LOGIN_URL=https://ibkr-login.<domain>` (https is required in production)
   - `NASSCORD_APP_URL=https://nasscord-phi.vercel.app` (or your domain)
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `BROKER_SERVICE_SECRET` (the same value as Vercel), `BROKER_TOKEN_KEY`, `BROKER_TOKEN_KEY_VERSION`
   - `ETRADE_ALLOW_SANDBOX`, set on purpose. The systemd unit sets `NODE_ENV=production`, and in production sandbox keys are **refused** unless `ETRADE_ALLOW_SANDBOX=true`. Set it to `true` while you test with a sandbox key (step 10), then to `false` for real users.
   - Leave out `IBKR_GATEWAY_BUNDLE`, `IBKR_GATEWAY_RUNTIME` and `JAVA_BIN` to use the defaults (the unit puts the runtime folder in `/var/lib/nasscord-broker/runtime`).
6. **Service**: copy `deploy/nasscord-broker.service` to `/etc/systemd/system/`, then `sudo systemctl daemon-reload && sudo systemctl enable --now nasscord-broker`. Check it with `curl -s http://127.0.0.1:8710/health` (it answers `{ "ok": true, ... }`) and `journalctl -u nasscord-broker -f`. Exit code 78 in the log means a bad configuration; the log names the variable.
7. **TLS**: copy `deploy/Caddyfile` to `/etc/caddy/Caddyfile`, set your domain in it (or `NASSCORD_DOMAIN` in Caddy's environment), and `sudo systemctl reload caddy`. Caddy gets the certificates itself once DNS points at the VPS. Check `https://broker.<domain>/health` from your own computer.
8. **The app**: in Vercel set `BROKER_SERVICE_URL=https://broker.<domain>` and the same `BROKER_SERVICE_SECRET`, then redeploy. The console's Health page shows the service as answering.

Back up `BROKER_TOKEN_KEY` somewhere other than the VPS.

## 12. Optional: workspace addresses and white-label domains

Every workspace gets an address, `<slug>.<NEXT_PUBLIC_APP_DOMAIN>`, and a white-label tenant can have its own domain. Both serve the same app and always show the signed-in user's own workspace; a white-label domain also shows its tenant's brand. Nothing serves them until you set them up; until then the workspace address that signup, the terminal and the console show is reserved for the workspace but does not open:

- **Workspace addresses**: in Vercel, add the domain `*.<domain>` to the project (Vercel needs its nameservers on the domain for a wildcard). In Supabase, **Authentication, URL Configuration**, add `https://*.<domain>/**` to the Redirect URLs. Sign-in is per address: the session cookie belongs to the host, so someone who opens their workspace address signs in there once.
- **A white-label domain** (for example `trade.acmecapital.com`): add it to the Vercel project, have the tenant create the CNAME record Vercel shows at their DNS provider, add `https://trade.acmecapital.com/**` to Supabase's Redirect URLs, then enter the domain in the tenant's branding (console, White-label). The domain shows the tenant's brand once white-label is granted.

Email links always use `NEXT_PUBLIC_SITE_URL`, so confirmation and reset links land on the main address.

## Troubleshooting

| What you see | What to check |
|---|---|
| "Supabase is not configured" | The three Supabase variables are set and the app was restarted (or redeployed on Vercel). |
| The confirmation link lands on sign-in with "That link has expired" | The template link from step 4, the Redirect URLs from step 3, and that the link was opened once only. |
| Signed in, but every page sends you to `/signup` | The workspace step was not finished. Open `/signup` and create the workspace. |
| A role change in the database does not apply | The layouts read the `members` row on every request, so check that row first. The session keeps a copy of the role for the first redirect: open `/signup` to refresh it from the row, or update `raw_app_meta_data` as step 7 shows. |
| Broker pages say the broker service cannot be reached | `BROKER_SERVICE_URL`, the service is running, and `BROKER_SERVICE_SECRET` is the same on both sides. |
| A sandbox E*TRADE key is refused on the VPS | The service runs with `NODE_ENV=production`, where sandbox keys need `ETRADE_ALLOW_SANDBOX=true` (step 11). |
| "Too many IBKR logins are waiting" | Logins that were started and not finished hold a slot until their 20-minute window ends. Raise `IBKR_MAX_PENDING_LOGINS` (default: half the slots) or add slots if real users hit it. |
| The IBKR login says it only opens from the Brokers page | It was opened from an email, another site or the address bar. Open Brokers in Nasscord and press Connect or Reconnect. |
| Emails stop arriving after a few signups | Supabase's built-in sender limit. Set up SMTP (step 3). |
