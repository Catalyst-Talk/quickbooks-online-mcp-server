create schema if not exists mcp_private;

comment on schema mcp_private is
  'Sensitive MCP and QuickBooks integration data. Not exposed through Supabase Data API.';

revoke all on schema mcp_private from public;
revoke all on schema mcp_private from anon;
revoke all on schema mcp_private from authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'quickbooks_connection_status'
      and n.nspname = 'mcp_private'
  ) then
    create type mcp_private.quickbooks_connection_status as enum (
      'active',
      'needs_reauth',
      'revoked',
      'disconnected'
    );
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'audit_action_type'
      and n.nspname = 'mcp_private'
  ) then
    create type mcp_private.audit_action_type as enum (
      'read',
      'write'
    );
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'audit_decision'
      and n.nspname = 'mcp_private'
  ) then
    create type mcp_private.audit_decision as enum (
      'allowed',
      'denied'
    );
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'audit_outcome'
      and n.nspname = 'mcp_private'
  ) then
    create type mcp_private.audit_outcome as enum (
      'success',
      'failure'
    );
  end if;
end
$$;

create table if not exists mcp_private.quickbooks_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  realm_id text not null,
  environment text not null check (environment in ('sandbox', 'production')),
  refresh_token_secret_id uuid not null references vault.secrets(id) on delete restrict,
  scopes jsonb not null default '[]'::jsonb,
  status mcp_private.quickbooks_connection_status not null default 'active',
  company_name text,
  metadata jsonb not null default '{}'::jsonb,
  connected_at timestamptz not null default now(),
  last_refreshed_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint quickbooks_connections_user_realm_env_key
    unique (user_id, realm_id, environment)
);

comment on table mcp_private.quickbooks_connections is
  'Per-user QuickBooks connection records. Refresh tokens are stored indirectly via Supabase Vault.';

comment on column mcp_private.quickbooks_connections.refresh_token_secret_id is
  'References vault.secrets(id). The raw QuickBooks refresh token must never be stored directly in this table.';

create index if not exists quickbooks_connections_user_id_idx
  on mcp_private.quickbooks_connections (user_id);

create index if not exists quickbooks_connections_status_idx
  on mcp_private.quickbooks_connections (status);

create index if not exists quickbooks_connections_last_used_idx
  on mcp_private.quickbooks_connections (last_used_at desc);

create table if not exists mcp_private.quickbooks_audit_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid,
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid references mcp_private.quickbooks_connections(id) on delete set null,
  realm_id text,
  tool_name text not null,
  action_type mcp_private.audit_action_type not null,
  decision mcp_private.audit_decision not null,
  outcome mcp_private.audit_outcome not null,
  error_code text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table mcp_private.quickbooks_audit_events is
  'Append-only audit trail for QuickBooks MCP access decisions and tool execution outcomes.';

create index if not exists quickbooks_audit_events_user_id_created_at_idx
  on mcp_private.quickbooks_audit_events (user_id, created_at desc);

create index if not exists quickbooks_audit_events_connection_id_created_at_idx
  on mcp_private.quickbooks_audit_events (connection_id, created_at desc);

create index if not exists quickbooks_audit_events_request_id_idx
  on mcp_private.quickbooks_audit_events (request_id);

create or replace function mcp_private.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists quickbooks_connections_set_updated_at
  on mcp_private.quickbooks_connections;

create trigger quickbooks_connections_set_updated_at
before update on mcp_private.quickbooks_connections
for each row
execute function mcp_private.set_updated_at();

alter table mcp_private.quickbooks_connections enable row level security;
alter table mcp_private.quickbooks_audit_events enable row level security;

revoke all on all tables in schema mcp_private from public;
revoke all on all tables in schema mcp_private from anon;
revoke all on all tables in schema mcp_private from authenticated;

revoke all on all sequences in schema mcp_private from public;
revoke all on all sequences in schema mcp_private from anon;
revoke all on all sequences in schema mcp_private from authenticated;

alter default privileges in schema mcp_private revoke all on tables from public;
alter default privileges in schema mcp_private revoke all on tables from anon;
alter default privileges in schema mcp_private revoke all on tables from authenticated;

alter default privileges in schema mcp_private revoke all on sequences from public;
alter default privileges in schema mcp_private revoke all on sequences from anon;
alter default privileges in schema mcp_private revoke all on sequences from authenticated;
