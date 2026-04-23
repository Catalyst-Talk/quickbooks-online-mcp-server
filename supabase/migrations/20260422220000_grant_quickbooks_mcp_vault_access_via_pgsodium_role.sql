-- `vault` is owned by `supabase_admin`, so the project `postgres` role used by
-- our server-side database access cannot directly `GRANT USAGE ON SCHEMA vault`.
--
-- The practical server-side fix is to grant membership in `pgsodium_keyiduser`,
-- which already has the Vault schema/object privileges required for
-- QuickBooks-MCP refresh-token secret storage.

grant pgsodium_keyiduser to "quickbooks-mcp";
