-- Nasscord: order entry (docs/real-backend.md section 13).
--
-- Deploy order: run this migration first, then deploy services/broker, then the app. The service reads
-- workspaces.orders_enabled on every order request and writes order_requests; the app reads orders_enabled
-- and user_settings.order_terms_accepted_at for its own gate, and the console writes orders_enabled. Before
-- this migration the app and the service treat the missing columns (Postgres 42703) as "off". Every
-- statement is guarded (if exists / if not exists), so running this file again succeeds and changes nothing.
--
-- What it adds:
-- - workspaces.orders_enabled: the super admin's switch per workspace. Off for every workspace, existing ones
--   included. orders_updated_at and orders_updated_by: when the switch last changed and who changed it.
-- - user_settings.order_terms_accepted_at: when the user accepted the one-time order entry notice.
-- - order_requests: one row per order ticket previewed in Nasscord. The client order id is made once per
--   ticket and stored before anything is sent; the broker service moves a row from preview to sending in one
--   conditional update, so a ticket is sent at most once. resolved_at and resolved_by: a member marked an
--   unconfirmed order as checked at the broker. Rows hold no key, token or other secret.
-- RLS: members of the workspace and the super admin read the rows of the workspace. Every write is the broker
-- service or a server action, with the service role.

alter table public.workspaces add column if not exists orders_enabled boolean not null default false;
alter table public.workspaces add column if not exists orders_updated_at timestamptz;
alter table public.workspaces add column if not exists orders_updated_by uuid references auth.users (id) on delete set null;

alter table public.user_settings add column if not exists order_terms_accepted_at timestamptz;

create table if not exists public.order_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- Who previewed it. Kept (null) when the user is deleted, like the account and connection below,
  -- so the record of what was sent survives a disconnect.
  user_id uuid references auth.users (id) on delete set null,
  connection_id uuid references public.broker_connections (id) on delete set null,
  account_id uuid references public.broker_accounts (id) on delete set null,
  -- The broker account, stable across a disconnect and a reconnect (which replace the broker_accounts
  -- rows, so account_id becomes null): the first 16 hex characters of sha256("<broker_id>:<external_id>").
  -- No account number. The duplicate checks, the cancel update and reconcile key on it.
  account_key text not null check (account_key ~ '^[0-9a-f]{16}$'),
  broker_id text not null check (broker_id in ('ibkr', 'etrade', 'alpaca')),
  method text not null check (method in ('ibkr_gateway', 'etrade_oauth1', 'alpaca_key')),
  environment text not null check (environment in ('production', 'paper')),
  -- The masked account number ("U12•••67") at the time of the order.
  account_display text not null check (char_length(account_display) between 1 and 40),
  client_order_id text not null unique check (client_order_id ~ '^nc[0-9a-f]{18}$'),
  symbol text not null check (symbol ~ '^[A-Z][A-Z0-9.]{0,9}$'),
  side text not null check (side in ('BUY', 'SELL')),
  quantity integer not null check (quantity between 1 and 1000000),
  order_type text not null check (order_type in ('MKT', 'LMT', 'STP', 'STP_LMT')),
  tif text not null check (tif in ('DAY', 'GTC')),
  bracket boolean not null default false,
  intent text not null default 'trade' check (intent in ('trade', 'close')),
  -- The validated ticket (prices included). No secrets.
  request jsonb not null,
  -- What the confirm dialog showed: estimate, quote, instrument, position before and after, warnings, notices.
  preview jsonb,
  -- What the adapter needs to place: IBKR conid, E*TRADE previewId and the previewed order, Alpaca asset id,
  -- earlier client order ids and approved messages of IBKR confirmation rounds. No secrets.
  broker_state jsonb not null default '{}'::jsonb,
  status text not null default 'preview' check (status in ('preview', 'sending', 'placed', 'rejected', 'unknown', 'needs_confirmation', 'cancel_requested', 'cancelled')),
  broker_order_id text check (broker_order_id is null or char_length(broker_order_id) between 1 and 64),
  -- Bracket legs: [{ "id": "...", "role": "entry" | "take_profit" | "stop_loss" }]
  broker_order_ids jsonb,
  -- What the broker said: IBKR questions, E*TRADE messages: [{ "id": "...", "text": "..." }]
  broker_messages jsonb,
  error text check (error is null or char_length(error) <= 500),
  attempts integer not null default 0 check (attempts between 0 and 10),
  expires_at timestamptz not null,
  sent_at timestamptz,
  placed_at timestamptz,
  reconciled_at timestamptz,
  -- A member checked an unconfirmed order at the broker and asked Nasscord to stop warning about it.
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists order_requests_workspace_idx on public.order_requests (workspace_id, created_at desc);
create index if not exists order_requests_account_idx on public.order_requests (account_id, symbol, created_at desc);
create index if not exists order_requests_open_idx on public.order_requests (workspace_id, status) where status in ('sending', 'unknown');
create index if not exists order_requests_broker_order_idx on public.order_requests (account_id, broker_order_id) where broker_order_id is not null;
-- A table made by an earlier draft of this file has no account_key: add it (the broker service always writes it).
alter table public.order_requests add column if not exists account_key text check (account_key ~ '^[0-9a-f]{16}$');
create index if not exists order_requests_account_key_idx on public.order_requests (account_key, symbol, side, sent_at desc);

alter table public.order_requests enable row level security;
drop policy if exists order_requests_read on public.order_requests;
create policy order_requests_read on public.order_requests for select
  using (workspace_id = public.my_workspace() or public.my_role() = 'superadmin');
-- No insert, update or delete policy: writes use the service role.

drop trigger if exists order_requests_touch on public.order_requests;
create trigger order_requests_touch before update on public.order_requests
  for each row execute function public.touch_updated_at();
