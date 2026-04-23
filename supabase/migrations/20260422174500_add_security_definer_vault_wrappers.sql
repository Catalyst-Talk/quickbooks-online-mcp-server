create or replace function mcp_private.create_quickbooks_refresh_token_secret(
  new_secret text,
  principal_id text,
  realm_id text
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select vault.create_secret(
    new_secret,
    null,
    'QuickBooks refresh token for principal ' || principal_id || ' realm ' || realm_id
  );
$$;

comment on function mcp_private.create_quickbooks_refresh_token_secret(text, text, text) is
  'Creates a Vault secret for a connector-bound QuickBooks refresh token using definer privileges.';

create or replace function mcp_private.read_quickbooks_refresh_token_secret(
  secret_id uuid
)
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where id = secret_id
  limit 1;
$$;

comment on function mcp_private.read_quickbooks_refresh_token_secret(uuid) is
  'Reads a Vault-backed QuickBooks refresh token using definer privileges.';

create or replace function mcp_private.delete_quickbooks_refresh_token_secret(
  secret_id uuid
)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from vault.secrets
  where id = secret_id;
$$;

comment on function mcp_private.delete_quickbooks_refresh_token_secret(uuid) is
  'Deletes a Vault-backed QuickBooks refresh token using definer privileges.';
