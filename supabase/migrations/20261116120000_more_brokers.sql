-- Nasscord: more brokers (docs/real-backend.md, "Connect flows").
--
-- Deploy order: run this migration first, then deploy services/broker, then the app. The new
-- service writes the new methods, columns and tables, so it needs this migration first. The app
-- reads data_as_of and scope, falls back to the init columns when they are missing (Postgres 42703),
-- and never reads external_ref. Existing rows (IBKR production/paper, E*TRADE production/sandbox)
-- already satisfy every new check. Every statement is guarded (if exists / if not exists), so
-- running this file again succeeds and changes nothing.
--
-- What it adds:
-- - the twelve broker ids of src/lib/types.ts (BrokerId) on connections and accounts
-- - the connect methods, each paired with its broker
-- - sample-data environments ("sandbox") only for the three methods whose developer sandboxes are
--   needed for testing (E*TRADE keys, tastytrade cert, Webull Connect sandbox). The broker service
--   refuses sandbox when NODE_ENV=production; the database only keeps it to these three.
-- - "paper" only where the paper account is the user's own (IBKR, Alpaca, Tradier sandbox token,
--   TradeStation SIM)
-- - external_ref (the broker-side identity of the login), data_as_of (aggregator sync time), scope
--   (OAuth scope granted) and one login per workspace, broker and environment
-- - broker_oauth_pending: the hand-off rows of an OAuth or aggregator login (hashes only)
-- - broker_aggregator_users: one SnapTrade user per workspace, its userSecret encrypted

-- ───────────────────────── broker ids and methods
alter table public.broker_connections drop constraint if exists broker_connections_broker_id_check;
alter table public.broker_connections add constraint broker_connections_broker_id_check check (
  broker_id in ('ibkr', 'etrade', 'alpaca', 'tradier', 'schwab', 'tastytrade', 'tradestation', 'webull', 'fidelity', 'robinhood', 'moomoo', 'public')
);

alter table public.broker_connections drop constraint if exists broker_connections_method_check;
alter table public.broker_connections add constraint broker_connections_method_check check (
  method in (
    'ibkr_gateway', 'ibkr_oauth', 'etrade_oauth1', 'alpaca_key', 'alpaca_oauth', 'tradier_token', 'tradier_oauth',
    'schwab_oauth', 'tastytrade_oauth', 'tradestation_oauth', 'webull_oauth', 'snaptrade'
  )
);

-- A method only ever talks to its own broker. SnapTrade reads the brokers that publish no API a
-- platform may use (Fidelity, Robinhood, Public, Moomoo), Webull until Webull approves Nasscord for
-- its Connect API, and Schwab (read only) and tastytrade while Nasscord waits for their own approvals.
alter table public.broker_connections drop constraint if exists broker_connections_method_broker_check;
alter table public.broker_connections add constraint broker_connections_method_broker_check check (
  (method in ('ibkr_gateway', 'ibkr_oauth') and broker_id = 'ibkr')
  or (method = 'etrade_oauth1' and broker_id = 'etrade')
  or (method in ('alpaca_key', 'alpaca_oauth') and broker_id = 'alpaca')
  or (method in ('tradier_token', 'tradier_oauth') and broker_id = 'tradier')
  or (method = 'schwab_oauth' and broker_id = 'schwab')
  or (method = 'tastytrade_oauth' and broker_id = 'tastytrade')
  or (method = 'tradestation_oauth' and broker_id = 'tradestation')
  or (method = 'webull_oauth' and broker_id = 'webull')
  or (method = 'snaptrade' and broker_id in ('fidelity', 'robinhood', 'public', 'moomoo', 'webull', 'schwab', 'tastytrade'))
);

-- ───────────────────────── environments
-- Sandbox = a broker's sample data. Developer-only: the broker service refuses it in production and
-- the app labels it "Sandbox · sample data". Kept here to the three methods whose sandboxes are
-- needed for testing.
alter table public.broker_connections drop constraint if exists broker_connections_sandbox_check;
alter table public.broker_connections add constraint broker_connections_sandbox_check check (
  environment <> 'sandbox' or method in ('etrade_oauth1', 'tastytrade_oauth', 'webull_oauth')
);

-- Paper = the user's own paper account, labelled Paper.
alter table public.broker_connections drop constraint if exists broker_connections_paper_check;
alter table public.broker_connections add constraint broker_connections_paper_check check (
  environment <> 'paper' or method in ('ibkr_gateway', 'ibkr_oauth', 'alpaca_key', 'alpaca_oauth', 'tradier_token', 'tradestation_oauth')
);

-- ───────────────────────── new connection columns
-- The broker-side identity of the login: Alpaca account id, TradeStation id_token sub, Schwab
-- id_token sub (or a hash of the App Key and the sorted account hashes), tastytrade customer id,
-- Webull identity_id, SnapTrade authorization id. Finds duplicates and checks reconnects. Never
-- sent to the browser.
alter table public.broker_connections add column if not exists external_ref text
  check (external_ref is null or char_length(external_ref) between 1 and 200);
-- When the broker or aggregator last synced the data Nasscord reads ("updated 8 min ago").
alter table public.broker_connections add column if not exists data_as_of timestamptz;
-- OAuth scope granted, e.g. 'read market'. Order entry later needs a new consent when it lacks trade.
alter table public.broker_connections add column if not exists scope text
  check (scope is null or char_length(scope) <= 200);

-- One live connection per broker login in a workspace. A disconnected row keeps its external_ref
-- and does not count. There is deliberately no method column: the same login connected another way
-- (an Alpaca key, then Alpaca Connect) is the same accounts, so the broker service moves the existing
-- row to the newer login's method and replaces its secret whole instead of adding a second row.
create unique index if not exists broker_connections_one_login_idx
  on public.broker_connections (workspace_id, broker_id, environment, external_ref)
  where external_ref is not null and status <> 'disconnected';

-- ───────────────────────── accounts
alter table public.broker_accounts drop constraint if exists broker_accounts_broker_id_check;
alter table public.broker_accounts add constraint broker_accounts_broker_id_check check (
  broker_id in ('ibkr', 'etrade', 'alpaca', 'tradier', 'schwab', 'tastytrade', 'tradestation', 'webull', 'fidelity', 'robinhood', 'moomoo', 'public')
);

-- ───────────────────────── OAuth and aggregator hand-off (service role only)
-- One row per login in progress. Stages:
--   start      created by POST /v1/oauth/start or /v1/aggregator/start (binding_hash, return_origin)
--   authorize  the canonical-host hop opened the broker page (state_hash set for OAuth)
--   exchanging the canonical callback took the row (single use) and is exchanging the code
--   claim      tokens are stored; the user's own host must claim with ticket + binding + session
-- Only sha256 hashes of the state, the ticket and the binding nonce are kept. Rows are taken once
-- (update ... where stage = ..., or delete ... returning), and expire after 10 minutes (5 for claim).
create table if not exists public.broker_oauth_pending (
  connection_id uuid primary key references public.broker_connections (id) on delete cascade,
  stage text not null default 'start' check (stage in ('start', 'authorize', 'exchanging', 'claim')),
  binding_hash text not null check (binding_hash ~ '^[0-9a-f]{64}$'),
  state_hash text unique check (state_hash is null or state_hash ~ '^[0-9a-f]{64}$'),
  ticket_hash text unique check (ticket_hash is null or ticket_hash ~ '^[0-9a-f]{64}$'),
  -- The origin the user started on (nasscord.com, a workspace subdomain, a white-label domain).
  return_origin text not null check (return_origin ~ '^https?://[a-z0-9.-]+(:[0-9]{2,5})?$'),
  -- The broker-side identity found at the code exchange, applied when the login is claimed.
  external_ref text check (external_ref is null or char_length(external_ref) between 1 and 200),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists broker_oauth_pending_expires_idx on public.broker_oauth_pending (expires_at);
alter table public.broker_oauth_pending enable row level security;
-- No policies: only the service role reads or writes it.

-- ───────────────────────── aggregator users (service role only)
-- One SnapTrade user per workspace (userId = the workspace id, never an email). The userSecret is
-- AES-256-GCM with BROKER_TOKEN_KEY, AAD 'snaptrade:<workspace_id>', same key_version rotation as
-- broker_secrets. Deleted when the workspace's last aggregator connection goes (stops per-user billing).
create table if not exists public.broker_aggregator_users (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  provider text not null default 'snaptrade' check (provider in ('snaptrade')),
  external_user_id text not null unique check (char_length(external_user_id) between 1 and 200),
  key_version integer not null default 1,
  iv text not null,
  tag text not null,
  ciphertext text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.broker_aggregator_users enable row level security;
-- No policies: only the service role reads or writes it.
drop trigger if exists broker_aggregator_users_touch on public.broker_aggregator_users;
create trigger broker_aggregator_users_touch before update on public.broker_aggregator_users
  for each row execute function public.touch_updated_at();
