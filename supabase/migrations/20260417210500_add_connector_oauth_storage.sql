create table if not exists mcp_private.connector_quickbooks_connections (
  id uuid primary key default gen_random_uuid(),
  principal_id text not null,
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
  constraint connector_quickbooks_connections_principal_realm_env_key
    unique (principal_id, realm_id, environment)
);

comment on table mcp_private.connector_quickbooks_connections is
  'Per-principal QuickBooks connections used by the Claude connector OAuth flow.';

comment on column mcp_private.connector_quickbooks_connections.principal_id is
  'Stable Claude connector principal identifier bound to the QuickBooks connection.';

create index if not exists connector_quickbooks_connections_principal_id_idx
  on mcp_private.connector_quickbooks_connections (principal_id);

create unique index if not exists connector_quickbooks_connections_one_active_per_principal_idx
  on mcp_private.connector_quickbooks_connections (principal_id)
  where status = 'active';

create index if not exists connector_quickbooks_connections_status_idx
  on mcp_private.connector_quickbooks_connections (status);

create index if not exists connector_quickbooks_connections_last_used_idx
  on mcp_private.connector_quickbooks_connections (last_used_at desc);

create table if not exists mcp_private.connector_quickbooks_audit_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid,
  principal_id text not null,
  connection_id uuid references mcp_private.connector_quickbooks_connections(id) on delete set null,
  realm_id text,
  tool_name text not null,
  action_type mcp_private.audit_action_type not null,
  decision mcp_private.audit_decision not null,
  outcome mcp_private.audit_outcome not null,
  error_code text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table mcp_private.connector_quickbooks_audit_events is
  'Append-only audit trail for connector-bound QuickBooks access decisions and tool execution outcomes.';

create index if not exists connector_quickbooks_audit_events_principal_id_created_at_idx
  on mcp_private.connector_quickbooks_audit_events (principal_id, created_at desc);

create index if not exists connector_quickbooks_audit_events_connection_id_created_at_idx
  on mcp_private.connector_quickbooks_audit_events (connection_id, created_at desc);

create index if not exists connector_quickbooks_audit_events_request_id_idx
  on mcp_private.connector_quickbooks_audit_events (request_id);

drop trigger if exists connector_quickbooks_connections_set_updated_at
  on mcp_private.connector_quickbooks_connections;

create trigger connector_quickbooks_connections_set_updated_at
before update on mcp_private.connector_quickbooks_connections
for each row
execute function mcp_private.set_updated_at();

create table if not exists mcp_private.connector_oauth_clients (
  client_id text primary key,
  client_secret text,
  redirect_uris jsonb not null default '[]'::jsonb,
  token_endpoint_auth_method text not null default 'none',
  grant_types jsonb not null default '["authorization_code","refresh_token"]'::jsonb,
  response_types jsonb not null default '["code"]'::jsonb,
  client_name text,
  scope text,
  client_id_issued_at bigint not null,
  client_secret_expires_at bigint,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists mcp_private.connector_oauth_pending_authorizations (
  intuit_state text primary key,
  principal_id text not null,
  client_id text not null references mcp_private.connector_oauth_clients(client_id) on delete cascade,
  redirect_uri text not null,
  claude_state text,
  code_challenge text not null,
  requested_scope text not null default '',
  resource text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists mcp_private.connector_oauth_authorization_codes (
  code_hash text primary key,
  client_id text not null references mcp_private.connector_oauth_clients(client_id) on delete cascade,
  principal_id text not null,
  redirect_uri text not null,
  code_challenge text not null,
  scope text not null default '',
  resource text,
  quickbooks_connection_id uuid not null references mcp_private.connector_quickbooks_connections(id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists mcp_private.connector_oauth_refresh_tokens (
  token_hash text primary key,
  client_id text not null references mcp_private.connector_oauth_clients(client_id) on delete cascade,
  principal_id text not null,
  scope text not null default '',
  resource text,
  quickbooks_connection_id uuid not null references mcp_private.connector_quickbooks_connections(id) on delete cascade,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists mcp_private.connector_oauth_access_tokens (
  token_hash text primary key,
  client_id text not null references mcp_private.connector_oauth_clients(client_id) on delete cascade,
  principal_id text not null,
  scope text not null default '',
  resource text,
  quickbooks_connection_id uuid not null references mcp_private.connector_quickbooks_connections(id) on delete cascade,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists connector_oauth_pending_authorizations_expires_at_idx
  on mcp_private.connector_oauth_pending_authorizations (expires_at);

create index if not exists connector_oauth_authorization_codes_client_id_idx
  on mcp_private.connector_oauth_authorization_codes (client_id);

create index if not exists connector_oauth_authorization_codes_expires_at_idx
  on mcp_private.connector_oauth_authorization_codes (expires_at);

create index if not exists connector_oauth_refresh_tokens_client_id_idx
  on mcp_private.connector_oauth_refresh_tokens (client_id);

create index if not exists connector_oauth_refresh_tokens_principal_id_idx
  on mcp_private.connector_oauth_refresh_tokens (principal_id);

create index if not exists connector_oauth_refresh_tokens_expires_at_idx
  on mcp_private.connector_oauth_refresh_tokens (expires_at);

create index if not exists connector_oauth_access_tokens_client_id_idx
  on mcp_private.connector_oauth_access_tokens (client_id);

create index if not exists connector_oauth_access_tokens_principal_id_idx
  on mcp_private.connector_oauth_access_tokens (principal_id);

create index if not exists connector_oauth_access_tokens_expires_at_idx
  on mcp_private.connector_oauth_access_tokens (expires_at);

alter table mcp_private.connector_quickbooks_connections enable row level security;
alter table mcp_private.connector_quickbooks_audit_events enable row level security;
alter table mcp_private.connector_oauth_clients enable row level security;
alter table mcp_private.connector_oauth_pending_authorizations enable row level security;
alter table mcp_private.connector_oauth_authorization_codes enable row level security;
alter table mcp_private.connector_oauth_refresh_tokens enable row level security;
alter table mcp_private.connector_oauth_access_tokens enable row level security;

revoke all on table mcp_private.connector_quickbooks_connections from public, anon, authenticated;
revoke all on table mcp_private.connector_quickbooks_audit_events from public, anon, authenticated;
revoke all on table mcp_private.connector_oauth_clients from public, anon, authenticated;
revoke all on table mcp_private.connector_oauth_pending_authorizations from public, anon, authenticated;
revoke all on table mcp_private.connector_oauth_authorization_codes from public, anon, authenticated;
revoke all on table mcp_private.connector_oauth_refresh_tokens from public, anon, authenticated;
revoke all on table mcp_private.connector_oauth_access_tokens from public, anon, authenticated;
