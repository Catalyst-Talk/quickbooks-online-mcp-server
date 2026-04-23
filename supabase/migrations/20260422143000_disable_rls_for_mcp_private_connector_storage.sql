-- The deployed MCP server uses a privileged server-side Postgres connection
-- for connector OAuth and QuickBooks storage operations. These tables are not
-- exposed through the Supabase Data API, so row-level security blocks the app
-- itself without providing meaningful tenant isolation.

alter table if exists mcp_private.quickbooks_connections disable row level security;
alter table if exists mcp_private.quickbooks_audit_events disable row level security;

alter table if exists mcp_private.connector_quickbooks_connections disable row level security;
alter table if exists mcp_private.connector_quickbooks_audit_events disable row level security;
alter table if exists mcp_private.connector_oauth_clients disable row level security;
alter table if exists mcp_private.connector_oauth_pending_authorizations disable row level security;
alter table if exists mcp_private.connector_oauth_authorization_codes disable row level security;
alter table if exists mcp_private.connector_oauth_refresh_tokens disable row level security;
alter table if exists mcp_private.connector_oauth_access_tokens disable row level security;
