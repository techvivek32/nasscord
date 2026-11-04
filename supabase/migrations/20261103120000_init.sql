-- Nasscord: first real schema. Run in a NEW Supabase project (not NOVA's).
-- Reads from the app go through the signed-in user's JWT, so RLS decides who sees what.
-- Every write goes through server code with the service role, after the server checks the session.
-- broker_secrets has RLS on and no policies: only the service role (the broker service) can touch it.

create extension if not exists pgcrypto;

-- ───────────────────────── tenants (distributors)
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name text not null,
  status text not null default 'active' check (status in ('active', 'pending', 'suspended')),
  commission_pct numeric(5, 2) not null default 25 check (commission_pct >= 0 and commission_pct <= 100),
  white_label boolean not null default false,
  -- TenantBranding: { name, accent, accentDark, domain?, supportEmail? }
  branding jsonb,
  -- Code a trader types at signup to join this tenant ("ACME"). Upper case, unique.
  referral_code text unique check (referral_code ~ '^[A-Z0-9-]{3,24}$'),
  owner_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

-- ───────────────────────── workspaces (one trading desk)
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name text not null check (char_length(name) between 1 and 80),
  plan text not null default 'pro' check (plan in ('starter', 'pro', 'desk', 'enterprise')),
  status text not null default 'trial' check (status in ('active', 'trial', 'past_due', 'suspended')),
  tenant_id uuid references public.tenants (id) on delete set null,
  timezone text not null default 'America/New_York',
  owner_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index workspaces_tenant_idx on public.workspaces (tenant_id);

-- ───────────────────────── members (one row per user: role and where they belong)
create table public.members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('superadmin', 'tenant', 'trader', 'tenant_user')),
  workspace_id uuid references public.workspaces (id) on delete set null,
  tenant_id uuid references public.tenants (id) on delete set null,
  full_name text not null default '',
  email text not null,
  created_at timestamptz not null default now(),
  -- tenant users always belong to a tenant; tenants always own one
  check (role not in ('tenant', 'tenant_user') or tenant_id is not null)
);
create index members_workspace_idx on public.members (workspace_id);
create index members_tenant_idx on public.members (tenant_id);

-- ───────────────────────── per-user trading defaults
create table public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  risk_pct numeric(4, 2) not null default 1 check (risk_pct > 0 and risk_pct <= 5),
  paper_mode boolean not null default true,
  extended_hours boolean not null default false,
  email_alerts boolean not null default true,
  push_alerts boolean not null default true,
  sms_alerts boolean not null default false,
  default_account_id uuid,
  updated_at timestamptz not null default now()
);

-- ───────────────────────── broker connections (one login at one broker)
create table public.broker_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  broker_id text not null check (broker_id in ('ibkr', 'etrade')),
  method text not null check (method in ('ibkr_gateway', 'ibkr_oauth', 'etrade_oauth1')),
  environment text not null default 'production' check (environment in ('production', 'sandbox', 'paper')),
  status text not null default 'pending' check (status in ('pending', 'active', 'expired', 'error', 'disconnected')),
  -- Plain-language reason shown next to the status ("E*TRADE tokens end at midnight ET").
  status_detail text,
  session_expires_at timestamptz,
  last_ok_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index broker_connections_workspace_idx on public.broker_connections (workspace_id);

-- ───────────────────────── accounts under a connection
create table public.broker_accounts (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.broker_connections (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  broker_id text not null check (broker_id in ('ibkr', 'etrade')),
  -- IBKR accountId ("U1234567") or E*TRADE accountIdKey. Never shown in full.
  external_id text not null,
  -- Masked number for display ("U12•••67").
  display_number text not null,
  label text not null,
  type text not null default 'individual' check (type in ('individual', 'ira', 'roth', 'margin', 'paper')),
  included boolean not null default true,
  created_at timestamptz not null default now(),
  unique (connection_id, external_id)
);
create index broker_accounts_workspace_idx on public.broker_accounts (workspace_id);

-- ───────────────────────── encrypted broker credentials (AES-256-GCM, key held by the broker service only)
create table public.broker_secrets (
  connection_id uuid primary key references public.broker_connections (id) on delete cascade,
  key_version integer not null default 1,
  iv text not null,
  tag text not null,
  ciphertext text not null,
  updated_at timestamptz not null default now()
);

-- ───────────────────────── forms on the public site
create table public.tenant_applications (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  company text not null,
  email text not null,
  offer text not null check (offer in ('commission', 'white_label')),
  expected_traders integer,
  notes text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  created_at timestamptz not null default now()
);

create table public.broker_requests (
  id uuid primary key default gen_random_uuid(),
  broker_name text not null,
  email text not null,
  created_at timestamptz not null default now()
);

-- ───────────────────────── audit log (append-only from the app)
create table public.audit_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_user_id uuid references auth.users (id) on delete set null,
  actor_email text,
  workspace_id uuid references public.workspaces (id) on delete set null,
  action text not null,
  target text,
  result text not null default 'ok' check (result in ('ok', 'denied', 'error')),
  ip text,
  meta jsonb
);
create index audit_events_at_idx on public.audit_events (at desc);
create index audit_events_workspace_idx on public.audit_events (workspace_id);

-- ───────────────────────── helpers for policies (security definer so they can read members under RLS)
create or replace function public.my_role() returns text
  language sql stable security definer set search_path = public
  as $$ select role from public.members where user_id = auth.uid() $$;

create or replace function public.my_workspace() returns uuid
  language sql stable security definer set search_path = public
  as $$ select workspace_id from public.members where user_id = auth.uid() $$;

create or replace function public.my_tenant() returns uuid
  language sql stable security definer set search_path = public
  as $$ select tenant_id from public.members where user_id = auth.uid() $$;

-- ───────────────────────── RLS: read access only. No insert/update/delete policies: writes use the service role.
alter table public.tenants enable row level security;
alter table public.workspaces enable row level security;
alter table public.members enable row level security;
alter table public.user_settings enable row level security;
alter table public.broker_connections enable row level security;
alter table public.broker_accounts enable row level security;
alter table public.broker_secrets enable row level security;
alter table public.tenant_applications enable row level security;
alter table public.broker_requests enable row level security;
alter table public.audit_events enable row level security;

create policy members_read on public.members for select
  using (user_id = auth.uid() or public.my_role() = 'superadmin'
         or (public.my_role() = 'tenant' and tenant_id = public.my_tenant()));

-- A tenant's own login reads its row; a tenant user (a trader who joined with the code) does not:
-- commission, referral code and owner are the tenant's business. Their branding is served by the
-- server with the service role.
create policy tenants_read on public.tenants for select
  using (public.my_role() = 'superadmin'
         or (public.my_role() = 'tenant' and id = public.my_tenant()));

create policy workspaces_read on public.workspaces for select
  using (public.my_role() = 'superadmin'
         or id = public.my_workspace()
         or (public.my_role() = 'tenant' and tenant_id = public.my_tenant()));

create policy user_settings_read on public.user_settings for select
  using (user_id = auth.uid());

create policy broker_connections_read on public.broker_connections for select
  using (workspace_id = public.my_workspace() or public.my_role() = 'superadmin');

create policy broker_accounts_read on public.broker_accounts for select
  using (workspace_id = public.my_workspace() or public.my_role() = 'superadmin');

create policy tenant_applications_read on public.tenant_applications for select
  using (public.my_role() = 'superadmin');

create policy broker_requests_read on public.broker_requests for select
  using (public.my_role() = 'superadmin');

-- Members read only the rows they acted in themselves. Rows the super admin's console actions write
-- about a workspace carry the super admin's email and address, so "every row of my workspace" is
-- too wide. The console reads the whole log with the service role.
create policy audit_events_read on public.audit_events for select
  using (public.my_role() = 'superadmin' or actor_user_id = auth.uid());

-- broker_secrets: RLS on, no policy at all. Only the service role reads or writes it.

-- keep updated_at honest
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger broker_connections_touch before update on public.broker_connections
  for each row execute function public.touch_updated_at();
create trigger broker_secrets_touch before update on public.broker_secrets
  for each row execute function public.touch_updated_at();
create trigger user_settings_touch before update on public.user_settings
  for each row execute function public.touch_updated_at();
