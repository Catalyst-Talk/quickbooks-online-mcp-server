# QuickBooks OAuth Callback Storage Flow

This document describes the production storage handoff for a multi-tenant QuickBooks OAuth callback.

It assumes:

1. the caller is already authenticated to our MCP server via the Claude connector OAuth flow
2. QuickBooks OAuth is being completed on deployed endpoints, not `localhost`
3. refresh tokens are stored in **Supabase Vault**
4. connection metadata is stored in `mcp_private.connector_quickbooks_connections`

This flow assumes the backend is using a **server-side database access path** for these writes, such as:

- a direct Postgres connection
- a tightly scoped SQL function layer

It should not rely on exposing `mcp_private` through the Supabase Data API.

This document assumes there is a separate privileged helper layer for Vault access. The migration in this repo creates the storage schema and tables, but it does not by itself create an RPC surface for secret creation or secret reads.

## Local vs Production

Two different flows should continue to exist.

### Local Development

- `npm run auth`
- browser opens locally
- callback writes tokens into `.env`
- intended for one developer and one local tenant

### Production Multi-Tenant

- `/oauth/quickbooks/start`
- `/oauth/quickbooks/callback`
- callback writes the refresh token to Vault
- callback writes or updates the connector principal's connection record in Supabase
- `.env` is never used for per-connector-installation production token persistence

## Storage Model

### Vault

Store the raw QuickBooks refresh token in `vault.secrets`.

The application should keep only the returned secret ID.

Current implementation note: the connector principal is stabilized with a signed HTTP-only cookie during the connector OAuth flow. That means the current storage model is per connector installation/browser session, not independently proven per human user identity unless Claude exposes a stronger stable subject in the future.

Vault reads and writes should happen only through privileged backend code or a tightly scoped SQL helper layer. Browser clients and low-privilege database roles should never access Vault directly.

### Metadata Table

Store all non-secret connection metadata in `mcp_private.connector_quickbooks_connections`.

That row should contain:

- `principal_id`
- `realm_id`
- `environment`
- `refresh_token_secret_id`
- `scopes`
- `status`
- timestamps and optional company metadata

## Required Inputs at Callback Time

When QuickBooks redirects back to `/oauth/quickbooks/callback`, the server should have access to:

- authenticated `principalId`
- OAuth `code`
- validated `state`
- QuickBooks `realmId`
- deployment environment (`sandbox` or `production`)

After token exchange, the callback handler should have:

- `refreshToken`
- `accessToken` (short-lived, not durably stored)
- `realmId`
- `scopes`

## Pseudocode for the Callback Write Path

```ts
async function handleQuickBooksCallback(req, res) {
  const principal = await requireAuthenticatedPrincipal(req);

  const state = req.query.state;
  await validateOauthStateOrThrow(principal.id, state);

  const tokenResponse = await exchangeQuickBooksCodeForTokens({
    code: req.query.code,
    redirectUri: process.env.QUICKBOOKS_REDIRECT_URI,
  });

  const refreshToken = tokenResponse.refresh_token;
  const realmId = tokenResponse.realmId;
  const scopes = tokenResponse.x_refresh_token_expires_in
    ? (tokenResponse.scopes ?? [])
    : (tokenResponse.scopes ?? []);
  const environment = process.env.QUICKBOOKS_ENVIRONMENT ?? "sandbox";

  if (!refreshToken || !realmId) {
    throw new Error("QuickBooks callback missing refresh token or realm ID");
  }

  const refreshTokenSecretId = await db
    .one(
      `
      select vault.create_secret(
        $1,
        null,
        'QuickBooks refresh token for principal ' || $2::text || ' realm ' || $3
      ) as id
    `,
      [refreshToken, principal.id, realmId],
    )
    .then((row) => row.id);

  const connection = await db.one(
    `
      insert into mcp_private.connector_quickbooks_connections (
        principal_id,
        realm_id,
        environment,
        refresh_token_secret_id,
        scopes,
        status,
        connected_at,
        revoked_at,
        last_refreshed_at,
        last_used_at
      )
      values ($1, $2, $3, $4, $5::jsonb, 'active', now(), null, null, null)
      on conflict (principal_id, realm_id, environment)
      do update set
        refresh_token_secret_id = excluded.refresh_token_secret_id,
        scopes = excluded.scopes,
        status = 'active',
        revoked_at = null,
        updated_at = now()
      returning *
    `,
    [
      principal.id,
      realmId,
      environment,
      refreshTokenSecretId,
      JSON.stringify(scopes),
    ],
  );

  await writeQuickBooksAuditEvent({
    userId: principal.id,
    connectionId: connection.id,
    realmId,
    toolName: "oauth_callback",
    actionType: "write",
    decision: "allowed",
    outcome: "success",
  });

  return res.redirect("/settings/integrations/quickbooks?status=connected");
}
```

## Recommended Helper Boundary

Do not spread Vault writes and connection upserts through route handlers.

Use a helper boundary like:

```ts
await storeQuickBooksConnection({
  principalId,
  realmId,
  environment,
  refreshToken,
  scopes,
  companyName,
});
```

That helper should:

1. create the Vault secret
2. upsert the connector-specific connection record
3. write the audit event
4. return the normalized connection object

The helper should own the DB transaction boundary if you want secret creation, connection upsert, and audit write to succeed or fail together.

If secret creation succeeds but the connection upsert fails, the helper should either delete the newly created Vault secret immediately or mark it for deterministic cleanup. Orphaned refresh-token secrets should not be a normal failure mode.

## Refresh Path

When an MCP tool request needs a QuickBooks client:

1. authenticate the caller via Claude connector OAuth
2. resolve the principal's active `connector_quickbooks_connections` row
3. load the plaintext refresh token from `vault.decrypted_secrets`
4. call QuickBooks refresh
5. construct a request-scoped QuickBooks client with:
   - the fresh access token
   - the row's `realm_id`
   - the row's `environment`
6. update `last_refreshed_at` and `last_used_at`

## Disconnect Path

On disconnect:

1. mark the connection row `revoked` or `disconnected`
2. if rotating to a new secret, update the connection row to point at the new `refresh_token_secret_id` first
3. if deleting the secret, update or delete the connection row before deleting the referenced Vault secret
4. block future MCP use of that connection
5. write an audit event

The migration uses `refresh_token_secret_id uuid not null references vault.secrets(id) on delete restrict`, so deleting the Vault secret first will fail by design.

## Logging Rules

Never log:

- refresh tokens
- access tokens
- raw Authorization headers
- full token exchange payloads

Safe to log:

- `principal_id`
- `connection_id`
- `realm_id`
- environment
- status transitions
- request IDs

## Vercel Secret Placement

Use Vercel sensitive environment variables for:

- `MCP_CONNECTOR_COOKIE_SECRET`
- `DATABASE_URL`
- `QUICKBOOKS_CLIENT_ID`
- `QUICKBOOKS_CLIENT_SECRET`
- app auth secrets

Do not use Vercel environment variables to store per-user QuickBooks refresh tokens.

## Access Pattern Warning

`mcp_private` should remain a private schema.

That means:

- do not expose it in Supabase Data API exposed schemas
- do not rely on browser or client-side Supabase access for these tables
- do not assume `supabase-js` over the REST API is the right write path here

Treat these writes as backend-only database operations.

## Reauthentication and Secret Rotation

On reconnect or reauth:

1. create a new Vault secret for the new refresh token
2. update the connection row to point to the new `refresh_token_secret_id`
3. verify the update succeeded
4. clean up the old secret in a controlled step

Do not assume the old secret can be deleted before the row has been updated away from it.
