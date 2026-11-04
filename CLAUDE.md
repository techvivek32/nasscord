@AGENTS.md

# Nasscord — project conventions

Nasscord is a multi-tenant, multi-broker trading platform for US traders (the productized successor of a single-user
IBKR terminal). This repo is the frontend: public site, onboarding, the trader terminal, the super admin console
and the tenant portal. The data is real: sign-in and the database are Supabase (Postgres with RLS), and broker data
comes from the user's own IBKR and E*TRADE accounts through the broker service (`services/broker`). The first release
is read-only (order entry is off). `docs/real-backend.md` is the binding contract; `docs/SETUP.md` is the setup guide.
There is no demo data: a panel without a real source shows `EmptyState`.

## Stack (do not add alternatives)
- Next.js 16 App Router, React 19, TypeScript strict. **Read `node_modules/next/dist/docs/` before using an API you are
  not sure about.** `proxy.ts` replaces middleware. `params` / `searchParams` are Promises. Use explicit prop types
  (`{ children: React.ReactNode }`, `{ params: Promise<{ id: string }> }`).
- Tailwind CSS v4 (tokens in `src/app/globals.css` via `@theme inline`). Dark mode = `.dark` class via `next-themes`.
- shadcn/ui **base-nova style on `@base-ui/react`** in `src/components/ui`. There is no `asChild`; compose with the
  `render` prop: `<Button render={<Link href="/x" />}>Label</Button>`, `<DialogTrigger render={<Button />}>`,
  `<SidebarMenuButton render={<Link href=… />}>`. Read the component file before using an unfamiliar one
  (`Select` needs `items` on the root for label display; `Switch` uses `checked` / `onCheckedChange`; `Tabs` items
  take `value`; `DropdownMenuLabel` must sit inside a `DropdownMenuGroup` or `DropdownMenuRadioGroup`, outside one
  the menu throws when it opens). Import `cn` from `@/lib/utils`.
- Icons: `lucide-react` only. Charts: `recharts` through `src/components/ui/chart.tsx` (`ChartContainer`,
  `ChartTooltip`, `ChartTooltipContent`, `ChartLegend`) plus `src/components/charts/sparkline.tsx` for tiny lines.
- Auth and database: Supabase through `@supabase/ssr` and `@supabase/supabase-js` (clients in `src/lib/supabase`).
- Data: client components use the `@tanstack/react-query` hooks in `src/hooks/queries.ts` (over the browser functions in
  `src/lib/api`, which call the app's own `/api/broker/*` routes); server components read through `src/lib/server/*`.
  Tables: `src/components/data-table.tsx` (TanStack Table). Forms: `react-hook-form` + `zod`.
  Toasts: `import { toast } from "sonner"`. Client state that must survive navigation: `zustand`.
- Do **not** run `npm install` or `npx shadcn add`; everything needed is installed. If something is truly missing,
  say so in your report instead.

## Where things live
```
src/app/(marketing)/…        public site: /, /pricing, /brokers, /tenants, /security (+ header/footer in layout)
src/app/(auth)/login|signup  sign-in and the 5-step onboarding wizard
src/app/(app)/app/…          trader terminal (workspace scoped; wears the tenant's brand when it has white-label)
src/app/(admin)/admin/…      super admin console: Traders (workspaces), Tenants, Users, White-label (its own section), …
src/app/(tenant)/tenant/…    tenant portal (commission for every tenant; Traders, Branding, Plans need white-label)
src/app/auth/confirm/route.ts  landing route of Supabase email links (verifyOtp, then a safe relative `next`)
src/app/(auth)/login/reset   set a new password after the reset link
src/app/api/broker/**        route handlers (Node runtime): session + member workspace check, then src/lib/server/broker-service
src/proxy.ts                 refreshes the Supabase session; host -> x-workspace (subdomain slug) / x-tenant (custom
                             domain, resolved on the server); gate from verified claims: no session -> /login?next=,
                             no role yet -> /signup. A claim role that does not fit the area passes through: the JWT
                             can lag a role change, so the layout (requireRole, from the members row) redirects instead
supabase/migrations/*.sql    the schema and RLS (reads through the user's JWT; every write is server code with the service role)
services/broker/             the broker service (separate Node 24 app, own checks): IBKR gateways, E*TRADE OAuth 1.0a,
                             the token key. The app talks to it with a 60 s HS256 service JWT
docs/real-backend.md         the contract (env vars, auth, routes, service API). If it and the SQL disagree, the SQL wins
docs/SETUP.md                owner's setup guide (Supabase project, migration, email templates, env vars, broker service)
src/lib/types.ts             the domain model — extend here, never invent parallel shapes
src/lib/brokers.ts           THE broker registry (names, monograms, colors, statuses). Render brokers from here only
src/lib/plans.ts             plans, prices, COMMISSION_PCT, WHITE_LABEL_FEE, TENANT_OFFERS (commission + white-label)
src/lib/engine.ts            TradeScope constants: 44 symbols, 15m, minScore 70, max 5 open, stop 2.2×ATR, R:R 0.72,
                             sizeByRisk (1% of net liq, 95% cash cap), backtest stats, market session helper
src/lib/supabase/*           server.ts (cookie client, acts as the user), admin.ts (service role, server only), client.ts
                             (browser), proxy.ts (session refresh), env.ts (config check, SUPABASE_NOT_CONFIGURED, safeNextPath)
src/lib/server/*             server-only modules: broker-service.ts (service JWT + typed calls, 8 s timeouts), workspace.ts
                             (current workspace, branding, settings), console.ts + console-actions.ts (super admin reads and
                             writes), tenant.ts + tenant-actions.ts (tenant portal), public-actions.ts (public forms), rows.ts
                             (DB rows -> domain types), audit.ts (audit_events). Every action re-checks the role and audits
src/lib/api/index.ts         browser functions over /api/broker/* (fetchConnections, fetchPositions, startEtrade, …)
src/lib/api/unavailable.ts   typed empty stubs for sources that do not exist yet (alerts, tickers, billing…): replace with EmptyState
src/hooks/queries.ts         react-query hooks; keys include the workspace id (src/components/workspace-scope.tsx, provided by
                             the terminal layout); clearQueryCache on sign-out. Hooks of missing sources stay idle
src/lib/auth.ts              getAuthUser / getSession / requireSession / requireRole (server; claims + members row).
                             src/lib/auth-actions.ts = auth and signup server actions; src/lib/signup.ts = their shared zod rules
src/lib/roles.ts             the four roles and who may open which area (CONSOLE_ROLES, TENANT_PORTAL_ROLES,
                             TERMINAL_ROLES, areasForRole), ROLE_LABEL, ROLE_DESCRIPTION. Roles: `superadmin` (platform
                             owner: console + tenant portal + their own terminal; the only one who grants white-label),
                             `tenant` (distributor, earns commission; portal only), `trader` (organic user) and
                             `tenant_user` (a trader who belongs to a tenant). Vocabulary: a `Tenant` is a distributor;
                             a `Workspace` is a trader's desk (the console calls these "Traders"). Pure data,
                             shared by proxy.ts, the layouts and the area switcher; change access here only
src/lib/branding.ts          pure branding/host rules (DEFAULT_BRANDING, whiteLabelBranding, hostFor): safe for client code
src/lib/tenant.ts            pure host parsing (resolveHost). src/lib/tenant-server.ts = tenant lookups in the DB (server only)
src/lib/nav.ts               sidebar/nav configs for terminal, console, tenant portal, marketing. Every NavItem needs a
                             `description`: the intro tour is built from it
src/lib/tours.ts             intro tour steps per area (sidebar steps come from lib/nav; extra steps target `data-tour`)
src/components/layout/app-shell.tsx   the shared sidebar + header shell (terminal, console, tenant portal all use it). It also
                             mounts the area switcher, the tour and its replay button
src/components/layout/user-menu.tsx   the one account menu (Settings, Sign out) for every area; do not copy it
src/components/tour/*        Tour (spotlight + card, opens once per area per browser) and TourButton
src/components/{brand,brokers,charts}/…, stat-card, pnl, page-header (PageHeader, EmptyState; DemoFlag is deprecated), status-dot,
data-table, tenant-theme, theme-toggle, marketing/container (Container, Section, SectionHead)
```

## Design system (read before styling anything)
- Tokens only. Colors come from Tailwind classes bound to tokens: `bg-background`, `bg-card`, `text-foreground`,
  `text-muted-foreground`, `border-border`, `bg-primary text-primary-foreground`, `bg-muted`, `bg-brand-soft`.
  Semantic: `text-gain-foreground` / `bg-gain-soft`, `text-loss-foreground` / `bg-loss-soft`, `text-warn-foreground` /
  `bg-warn-soft`. Charts: `var(--chart-1..5)`. **Never hardcode a hex color** except the broker monogram tile
  (already handled by `BrokerMark`). Gain/loss/warn colors are for P&L and status only, never decoration.
- Type: headings use the `font-heading` face automatically (Instrument Sans). UI text is IBM Plex Sans. Tickers,
  prices, ids: `font-mono` + `tabular`. Uppercase labels get `tracking-wide`. Headings get `tracking-tight`.
- Layout: left-aligned, generous spacing with `gap-*`, hairline `border-border` dividers between sections, cards only
  for functional objects (broker tiles, plans, stat tiles, alert cards, tables). No gradient heroes in the app areas,
  nothing centered by default, no emoji, no em-dashes in copy.
- Public website (`src/app/(marketing)`) keeps the cobalt palette but has its own editorial layer: square controls,
  hairline rules, numbered sections, dot-grid panels (`DotPanel`, the `dotgrid` utility) and the cord chart
  (`marketing/cord-diagram.tsx`) in the home hero. Website-only names map onto app tokens under `.site-theme` in
  globals.css (`site-accent`, `site-accent-ink`, `site-accent-soft`, `site-band`). Type: Instrument Serif for
  headings (put the emphasis word in `<em>`), Instrument Sans for text, IBM Plex Mono for labels and numbers; loaded
  by the marketing layout (`marketing/site-fonts.ts`). Building blocks: `PageHero`, `SectionHead` / `Eyebrow`,
  `Statement`, `PaperCard`, `DotPanel`, the `site-label` / `site-caption` / `site-link` utilities, and motion via
  `reveal()` / `delay()` (`marketing/motion.ts`) with `RevealRoot`. Keep motion calm and reduced-motion safe.
- Reuse: `StatCard` for every KPI, `BrokerMark` + `BrokerStatusBadge` for every broker, `Pnl` / `PctChange` for signed
  numbers, `DataTable` for tables with more than ~6 rows, `PageHeader` at the top of every app page. No demo numbers: a panel
  without a real source shows `EmptyState` with a plain sentence about what is missing (`DemoFlag` is deprecated).
- Responsive: every page works at 375px and 1440px. Grids stack; tables scroll inside `DataTable` / `overflow-x-auto`;
  the sidebar collapses (already handled by `AppShell`).
- States: every interactive control does something visible (state change, `toast`, dialog, navigation). Loading via
  `Skeleton`; empty via `EmptyState`. Confirmations are `Dialog`s (no `window.confirm`).
- Copy: plain, specific, user-side language. Active voice. Numbers come from the user's own data or the product facts; nothing invented,
  nothing that contradicts `lib/engine.ts`, `lib/plans.ts` or `lib/brokers.ts`.

## Server vs client
- Pages and layouts are server components by default. Read session/workspace there (`getSession`, `getCurrentWorkspace`)
  and pass plain data down. Put `"use client"` on interactive leaf components, not on whole pages, unless the page is
  entirely interactive (the terminal pages mostly are; that is fine).
- Server actions live in files with `"use server"` and export only async functions.
- Never import `next/headers`, `src/lib/server/*` or `src/lib/supabase/admin.ts` in a client component: client data goes
  through the hooks in `src/hooks/queries.ts`. `SUPABASE_SERVICE_ROLE_KEY` and `BROKER_SERVICE_SECRET` never reach the
  browser; never log a secret, token or broker credential.
- Time: measure "x ago", "today" and ranges from the real clock (inside effects or event handlers, or a ticking clock
  hook; `react-hooks/purity` rejects `new Date()` during render).
- Route handlers and server actions check the session themselves (the proxy is not a security boundary) and answer
  errors as a sentence a user can read: `{ "error": "…" }` from routes, `{ ok: false, error }` from actions.

## Verify before you finish (agents)
- `npx tsc --noEmit` must pass for your files. `npm run lint` must not report errors in your files.
- Do **not** run `next build` or `next dev` while other agents are working; the integrator does that at the end.
- Report anything you could not finish rather than leaving a stub that looks done.
