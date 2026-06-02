# QuickBooks Online MCP Server - Multi-Tenant QuickBooks Auth Design

## Overview

Design a security-first, multi-tenant authentication architecture for the deployed streamable HTTP QuickBooks MCP server so each user can connect their own QuickBooks account and use MCP tools against only their own QuickBooks tenant.

The current Vercel deployment proves that the MCP transport works, but it does not yet provide a safe per-user QuickBooks connection model. This design replaces shared tenant fallback and raw token-forwarding as the primary product path with a Claude connector OAuth boundary and server-managed QuickBooks OAuth connections.

## Problem Statement

Today the deployed MCP endpoint has these properties:

1. `/mcp` is reachable and transport-compatible for streamable HTTP clients.
2. Requests may include `Authorization: Bearer <token>`, and that bearer is treated as a QuickBooks access token for the request.
3. If no bearer token is supplied, the server falls back to shared `QUICKBOOKS_*` environment variables.
4. The local `npm run auth` flow is a localhost bootstrap flow that writes tokens to `.env` and is not a deployed end-user login flow.
5. Bearer-token mode still relies on a global `QUICKBOOKS_REALM_ID`, which is not a real multi-tenant model.

That design is acceptable for local development and some trusted server-to-server scenarios, but it is not acceptable for a public or multi-user deployment where users connect their own QuickBooks accounts.

## Goals

1. **Per-principal QuickBooks connections** - each Claude connector principal can connect exactly one active QuickBooks company at a time.
2. **No anonymous QuickBooks access** - every MCP request resolves to an authenticated Claude connector principal or trusted service principal.
3. **Strong tenant isolation** - one user's MCP requests must never execute against another user's QuickBooks tenant.
4. **No shared credential fallback in multi-tenant mode** - requests without a bound QuickBooks connection fail closed.
5. **Server-side token lifecycle management** - refresh, revocation, reconnect, and audit happen in one place.
6. **Claude-compatible remote MCP usage** - Claude authenticates to our MCP service, not directly to QuickBooks.
7. **Low blast radius for compromise** - compromised connector tokens or leaked request tokens should not expose every connected QuickBooks account.

## Non-Goals

1. Support anonymous public use of `/mcp`.
2. Treat Claude as the system of record for QuickBooks refresh tokens.
3. Preserve `.env` token storage as a production auth mechanism.
4. Support one global QuickBooks tenant for all users in multi-tenant mode.
5. Add browser CORS support for arbitrary frontend clients in this phase.

## Current Architecture

### Existing Structure (Relevant)

```
api/
├── mcp.ts                         # Vercel MCP HTTP entrypoint
└── health.ts                      # Vercel health endpoint

src/
├── auth-server.ts                 # Local OAuth bootstrap CLI
├── clients/
│   ├── auth-context.ts            # Request-scoped access token storage
│   └── quickbooks-client.ts       # QuickBooks OAuth + API client
├── handlers/*.handler.ts          # Business logic calling getQuickbooks()
└── server/
    ├── qbo-mcp-server.ts          # MCP server factory
    └── streamable-http-handler.ts # Streamable HTTP transport handler
```

### Current Request Flow

```
Claude / MCP Client
  -> /mcp
  -> streamable-http-handler.ts
  -> optional Authorization bearer extracted into request context
  -> handler calls getQuickbooks()
  -> getQuickbooks() chooses:
       A) request bearer token + global realm
       B) shared env credentials + refresh token fallback
  -> QuickBooks API
```

### Current Security Gaps

1. `/mcp` does not authenticate the caller to the app.
2. Shared env fallback can silently route requests to a shared QuickBooks tenant.
3. Raw bearer-token forwarding assumes the caller already solved QuickBooks OAuth.
4. Realm binding is not per-user.
5. `npm run auth` is localhost-only and cannot serve deployed end users.
6. There is no per-user audit trail for QuickBooks actions.

## Design Principles

1. **Authenticate the caller before touching QuickBooks.**
2. **Bind every QuickBooks action to one connector principal and one QuickBooks connection.**
3. **Store refresh tokens server-side, encrypted at rest, never in plaintext logs.**
4. **Refresh access tokens just-in-time and keep them short-lived.**
5. **Fail closed when connection context is missing or ambiguous.**
6. **Make tenant selection explicit if a user can connect multiple QuickBooks companies.**
7. **Prefer Claude connector OAuth plus server-managed downstream refresh tokens over client-managed SaaS refresh tokens.**

## Proposed Architecture

### High-Level Flow

```
Claude
  -> authenticates to our MCP service
  -> POST /mcp
  -> app auth resolves caller identity
  -> MCP request context resolves user -> QuickBooks connection
  -> server refreshes QuickBooks access token if needed
  -> handler executes against exactly one realm/company
  -> audit log records user, realm, tool, outcome
```

### Architecture Components

#### 1. Claude Connector Authentication Layer

Add required caller authentication in front of `/mcp`.

Responsibilities:

- validate MCP OAuth bearer tokens for this resource
- resolve connector principal identity and authorization context
- reject anonymous requests
- attach `principalId` and auth metadata to request context

This layer authenticates the user to **our MCP service**. It does not authenticate directly to QuickBooks.

#### 2. QuickBooks Connection Service

Add a new application-level concept representing a connector principal's QuickBooks connection.

Suggested fields:

```
QuickBooksConnection
- id
- userId
- quickbooksRealmId
- quickbooksEnvironment            # sandbox | production
- encryptedRefreshToken
- tokenScopes
- status                           # active | revoked | needs_reauth | disconnected
- connectedAt
- lastRefreshedAt
- lastUsedAt
- revokedAt
- metadata                         # optional company display info
```

Responsibilities:

- create connection on OAuth callback
- refresh access tokens on demand
- revoke/disconnect safely
- expose a single active connection per request, or require explicit selection

#### 3. Request Auth Context

Replace the current context shape of just `{ accessToken }` with a richer request context.

Suggested shape:

```ts
interface RequestAuthContext {
  principalId: string;
  sessionId?: string;
  quickBooksConnectionId?: string;
  quickBooksRealmId?: string;
  quickBooksEnvironment?: "sandbox" | "production";
}
```

The key change is that request handling should resolve **identity first**, then derive the QuickBooks connection from trusted server-side state.

#### 4. QuickBooks Client Factory

Refactor QuickBooks client creation so handlers never infer tenant from env fallback in multi-tenant mode.

New model:

1. request arrives authenticated
2. connection lookup resolves the principal's active QuickBooks connection
3. server refreshes the access token using the stored refresh token
4. server constructs a QuickBooks client with the refreshed access token and that connection's realm ID
5. handlers use the resulting client

#### 5. OAuth Endpoints for Deployed Use

Add deployed QuickBooks OAuth endpoints to replace localhost bootstrap for end users.

Suggested endpoints:

```
GET  /oauth/quickbooks/start
GET  /oauth/quickbooks/callback
POST /oauth/quickbooks/disconnect
GET  /oauth/quickbooks/status
```

Responsibilities:

- start OAuth for the currently authenticated connector principal
- validate `state` and callback integrity
- exchange code for refresh token + realm ID
- persist encrypted connection data
- expose connection status to the user or control plane

`npm run auth` remains as a local development helper only.

## Authentication Model

### Layer 1: Caller Auth to MCP Server

This is required.

Options:

- MCP OAuth bearer token issued for this MCP resource

Requirements:

- all `/mcp` requests must authenticate
- auth failure returns 401 or 403 before any QuickBooks logic runs
- the authenticated principal determines which QuickBooks connection can be used

### Layer 2: QuickBooks OAuth to Intuit

This is user consent for downstream QuickBooks access.

Requirements:

- performed through deployed OAuth endpoints
- consent tied to the currently authenticated connector principal
- callback stores `realmId` and refresh token for that principal
- server refreshes access tokens server-side as needed

### Layer 3: Tool Authorization Within a Tenant

Caller authentication alone is not enough.

Requirements:

- authenticated callers must also be authorized for the selected tenant
- authorization should distinguish at minimum between **read/report tools** and **write/mutating tools**
- deny-by-default applies to write tools until an explicit policy grants access
- service principals must have explicit tenant bindings and tool-class permissions

This prevents a valid connector session from automatically becoming unlimited QuickBooks write access.

### Why Claude Should Not Be the System of Record for QuickBooks Tokens

Claude can store credentials for reaching **our MCP server**. That does not make it the right place to own QuickBooks refresh tokens.

Reasons:

1. QuickBooks OAuth requires refresh lifecycle management.
2. The server needs realm/company binding, not just a raw token.
3. Revocation, reconnect, and audit belong in one trusted control plane.
4. Client-side token ownership turns the MCP server into a thin token-forwarding proxy with weak operational control.

## Threat Model

### Primary Threats

1. **Anonymous MCP access**
   - attacker uses `/mcp` without connector auth
   - current risk: can hit shared env-backed QuickBooks tenant

2. **Cross-tenant access**
   - user A triggers actions against user B's QuickBooks realm
   - root cause: missing or ambiguous connection binding

3. **Refresh token compromise**
   - leaked DB rows, logs, backups, or debug output expose long-lived QuickBooks access

4. **Compromised connector session**
   - attacker reuses a valid connector token and drives QuickBooks operations through MCP

5. **Confused deputy behavior**
   - caller supplies arbitrary bearer token or realm hint that the server trusts incorrectly

6. **Silent fallback to shared tenant**
   - missing per-user connection causes requests to run against the server's env credentials

### Security Requirements

1. `/mcp` must require caller auth.
2. Multi-tenant mode must disable shared env fallback.
3. Refresh tokens must be encrypted at rest.
4. Access tokens must be short-lived and not stored longer than needed.
5. Realm ID must be resolved from trusted server-side connection state.
6. Every tool call must emit an audit event with user, connection, realm, tool, and result.
7. Disconnect must revoke or disable future QuickBooks use immediately.
8. Write tools must be authorized separately from read/report tools.
9. Token refresh failures and suspicious tenant mismatches must fail closed and quarantine the connection until reviewed or reauthorized.

## Data Handling

### Store

- encrypted QuickBooks refresh token
- realm ID
- environment
- granted scopes
- timestamps and status
- minimal display metadata needed for UX

### Do Not Store

- plaintext refresh tokens in logs
- access tokens longer than operationally necessary
- shared `.env` token values as a fallback for multi-tenant mode

### Logging Rules

- never log refresh tokens
- never log raw access tokens
- log token refresh success/failure without secret material
- log realm and connection IDs, not sensitive token bodies

## Revocation and Failure Handling

### Disconnect / Revoke

When a user disconnects QuickBooks:

1. mark the `QuickBooksConnection` as `revoked` or `disconnected`
2. clear any cached access-token material
3. block future MCP tool calls for that connection
4. require a fresh OAuth consent flow to reconnect

### Token Refresh Failure

When refresh fails:

1. do not silently retry forever
2. mark the connection `needs_reauth` after a bounded retry policy
3. return a deterministic `QuickBooks reauthorization required` error to the caller
4. emit an audit event for incident review

### Tenant Mismatch / Suspicious State

If request identity, connection identity, bearer context, or realm binding disagree:

1. reject the request
2. do not fall back to shared env credentials
3. optionally quarantine the connection or session depending on severity
4. emit a high-signal security event with request ID, caller ID, and connection ID

## Request Resolution Rules

For each MCP request:

1. authenticate caller via Claude connector OAuth
2. resolve one allowed QuickBooks connection for the caller
3. if zero connections, return `not connected to QuickBooks`
4. if multiple connections and no explicit selection, return `connection selection required`
5. refresh access token if required
6. construct QuickBooks client with the selected realm ID
7. execute handler
8. emit audit event

There should be no code path that silently falls back to a shared tenant in multi-tenant mode.

## Tooling and UX Implications

### For Claude

Claude should authenticate to **our service**.

Claude should not be expected to:

- own QuickBooks refresh tokens
- refresh QuickBooks tokens itself
- remember realm IDs as authoritative tenant state
- decide which downstream QuickBooks company is valid for a user

Claude may still store credentials for reaching **our MCP server**, but that is distinct from being the system of record for QuickBooks refresh tokens.

### For End Users

Expected user journey:

1. connect to the MCP server from Claude
2. click **Connect** in Claude
3. complete Intuit OAuth consent through the server-brokered flow
4. return with the QuickBooks connection active for that Claude principal
5. use Claude against our MCP server
6. MCP requests run against that user's QuickBooks company only

## Migration Plan

### Phase 1: Security Boundary

1. add required caller auth to `/mcp`
2. add feature flag for multi-tenant mode
3. disable anonymous access in deployed environments

### Phase 2: Connection Model

1. add `QuickBooksConnection` persistence model
2. add encrypted refresh-token storage
3. add connection lookup by authenticated user

### Phase 3: OAuth for Deployed Users

1. add `/oauth/quickbooks/start`
2. add `/oauth/quickbooks/callback`
3. add disconnect/status endpoints
4. remove `.env` dependence from deployed user flows

### Phase 4: Request Path Hardening

1. refactor `getQuickbooks()` to resolve from request auth context
2. remove shared env fallback in multi-tenant HTTP mode
3. add explicit connection selection behavior if needed

### Phase 5: Audit and Operations

1. add security audit logs
2. add revocation flow
3. add suspicious activity monitoring and rate limits

## Rollout Strategy

1. keep current env-backed mode only for local development and explicitly single-tenant environments
2. introduce multi-tenant mode behind a feature flag
3. onboard internal/test users first
4. verify tenant isolation and revocation behavior before broader rollout

## Security Review Checklist

Before this design is considered production-ready:

1. `/mcp` rejects anonymous requests in deployed multi-tenant mode
2. shared env fallback is disabled in deployed multi-tenant mode
3. refresh tokens are encrypted at rest with managed keys
4. realm selection is derived from trusted connection state, not caller input alone
5. write tools are deny-by-default until explicitly authorized
6. revocation and reauth flows are tested end to end
7. audit events exist for connect, disconnect, refresh failure, allow, deny, and tool execution outcome
8. no secret material appears in logs, traces, or error payloads

## Open Questions

1. Should a future version distinguish human users from connector installations if Claude exposes a stronger stable subject than the current cookie-backed connector principal?
2. What stable principal information from Claude will we persist and bind to `mcp_private.connector_quickbooks_connections`?
3. Do we need service-account style access for backend automations, separate from human user sessions?
4. What retention period is required for audit logs involving QuickBooks operations?
5. What is the exact encryption/key-management system for refresh-token storage?
6. Do we need admin workflows for forced disconnect and incident response?

## Recommendation

The recommended production design is:

1. **Authenticate the caller to the MCP service**
2. **Run QuickBooks OAuth on deployed endpoints owned by the app**
3. **Store encrypted per-principal QuickBooks refresh tokens and realm IDs server-side**
4. **Resolve one user-bound QuickBooks connection per MCP request**
5. **Authorize tool classes separately, especially writes**
6. **Remove shared env fallback in multi-tenant mode**

That gives the best chance of making this useful for Claude while not turning the MCP server into an attack amplifier for compromised QuickBooks accounts.
