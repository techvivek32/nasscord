@AGENTS.md

# Nasscord — project conventions

Nasscord is a multi-tenant, multi-broker trading platform for US traders (the productized successor of a single-user
IBKR terminal). This repo is the frontend: public site, onboarding, the trader terminal, the platform operator console
and the partner portal. Data is served from a mock data layer today; every fetch goes through `src/lib/api` so a real
backend can replace it without touching pages.

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
- Data: `@tanstack/react-query` hooks in `src/hooks/queries.ts` (client) or the async functions in `src/lib/api`
  (server components). Tables: `src/components/data-table.tsx` (TanStack Table). Forms: `react-hook-form` + `zod`.
  Toasts: `import { toast } from "sonner"`. Client state that must survive navigation: `zustand`.
- Do **not** run `npm install` or `npx shadcn add`; everything needed is installed. If something is truly missing,
  say so in your report instead.

## Where things live
```
src/app/(marketing)/…        public site: /, /pricing, /brokers, /partners, /security (+ header/footer in layout)
src/app/(auth)/login|signup  sign-in and the 5-step onboarding wizard
src/app/(app)/app/…          trader terminal (tenant scoped, white-label aware)
src/app/(admin)/admin/…      platform operator console
src/app/(partner)/partner/…  partner portal (white-label / referral / embedded)
src/proxy.ts                 tenant resolution from host -> x-tenant header; optimistic auth gate
src/lib/types.ts             the domain model — extend here, never invent parallel shapes
src/lib/brokers.ts           THE broker registry (names, monograms, colors, statuses). Render brokers from here only
src/lib/plans.ts             plans, prices, partner models
src/lib/engine.ts            TradeScope constants: 44 symbols, 15m, minScore 70, max 5 open, stop 2.2×ATR, R:R 0.72,
                             sizeByRisk (1% of net liq, 95% cash cap), backtest stats, market session helper
src/lib/mock/*               demo data (tenants, trading, platform). Pages read it via src/lib/api, not directly
src/lib/demo-clock.ts        DEMO_NOW, the instant the demo data is pinned to. Measure "x ago" / "today" / ranges from
                             it, not from new Date(); only the market session uses the real clock
src/lib/api/index.ts         async data functions (swap point for the real backend)
src/hooks/queries.ts         react-query hooks with production-like refetch intervals
src/lib/auth.ts              getSession / requireSession / requireRole (server). src/lib/auth-actions.ts = server actions
src/lib/roles.ts             who may open which area (CONSOLE_ROLES, PARTNER_PORTAL_ROLES, areasForRole), ROLE_LABEL.
                             `superadmin` is the platform owner: console + partner portal + his own terminal. Pure data,
                             shared by proxy.ts, the layouts and the area switcher; change access here only
src/lib/tenant*.ts           host -> tenant, branding, getCurrentTenant()
src/lib/nav.ts               sidebar/nav configs for terminal, console, partner portal, marketing. Every NavItem needs a
                             `description`: the intro tour is built from it
src/lib/tours.ts             intro tour steps per area (sidebar steps come from lib/nav; extra steps target `data-tour`)
src/components/layout/app-shell.tsx   the shared sidebar + header shell (terminal, console, partner all use it). It also
                             mounts the area switcher, the tour and its replay button
src/components/layout/user-menu.tsx   the one account menu (Settings, Sign out) for every area; do not copy it
src/components/tour/*        Tour (spotlight + card, opens once per area per browser) and TourButton
src/components/{brand,brokers,charts}/…, stat-card, pnl, page-header (PageHeader, DemoFlag, EmptyState), status-dot,
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
  for functional objects (broker tiles, plans, stat tiles, alert cards, tables). No gradient heroes, nothing centered
  by default, no emoji, no em-dashes in copy.
- Reuse: `StatCard` for every KPI, `BrokerMark` + `BrokerStatusBadge` for every broker, `Pnl` / `PctChange` for signed
  numbers, `DataTable` for tables with more than ~6 rows, `PageHeader` at the top of every app page, `DemoFlag` on
  panels that show demo numbers a real user could mistake for their own (terminal, console, partner).
- Responsive: every page works at 375px and 1440px. Grids stack; tables scroll inside `DataTable` / `overflow-x-auto`;
  the sidebar collapses (already handled by `AppShell`).
- States: every interactive control does something visible (state change, `toast`, dialog, navigation). Loading via
  `Skeleton`; empty via `EmptyState`. Confirmations are `Dialog`s (no `window.confirm`).
- Copy: plain, specific, user-side language. Active voice. Real numbers from the mock data; nothing invented that
  contradicts `lib/engine.ts`, `lib/plans.ts` or `lib/brokers.ts`.

## Server vs client
- Pages and layouts are server components by default. Read session/tenant there (`getSession`, `getCurrentTenant`)
  and pass plain data down. Put `"use client"` on interactive leaf components, not on whole pages, unless the page is
  entirely interactive (the terminal pages mostly are; that is fine).
- Server actions live in files with `"use server"` and export only async functions.
- Never import `next/headers` in a client component. Never import `src/lib/mock/*` into client components for data
  that should come from the server: use the hooks in `src/hooks/queries.ts`.

## Verify before you finish (agents)
- `npx tsc --noEmit` must pass for your files. `npm run lint` must not report errors in your files.
- Do **not** run `next build` or `next dev` while other agents are working; the integrator does that at the end.
- Report anything you could not finish rather than leaving a stub that looks done.
