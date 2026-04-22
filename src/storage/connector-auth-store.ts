import crypto from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { queryOne, queryRows, withPgTransaction } from "./postgres.js";

const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type OAuthClientRow = QueryResultRow & {
  client_id: string;
  client_secret: string | null;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  grant_types: string[];
  response_types: string[];
  client_name: string | null;
  scope: string | null;
  client_id_issued_at: number;
  client_secret_expires_at: number | null;
};

type QuickBooksConnectionRow = QueryResultRow & {
  id: string;
  principal_id: string;
  realm_id: string;
  environment: "sandbox" | "production";
  refresh_token_secret_id: string;
  scopes: unknown;
  status: "active" | "needs_reauth" | "revoked" | "disconnected";
  company_name: string | null;
};

type PendingAuthorizationRow = QueryResultRow & {
  intuit_state: string;
  principal_id: string;
  client_id: string;
  redirect_uri: string;
  claude_state: string | null;
  code_challenge: string;
  requested_scope: string;
  resource: string | null;
  expires_at: Date;
};

type AuthorizationCodeRow = QueryResultRow & {
  client_id: string;
  principal_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  resource: string | null;
  quickbooks_connection_id: string;
  connection_status?: "active" | "needs_reauth" | "revoked" | "disconnected";
  expires_at: Date;
  consumed_at: Date | null;
};

type RefreshTokenRow = QueryResultRow & {
  client_id: string;
  principal_id: string;
  scope: string;
  resource: string | null;
  quickbooks_connection_id: string;
  connection_status?: "active" | "needs_reauth" | "revoked" | "disconnected";
  expires_at: Date;
  revoked_at: Date | null;
};

type AccessTokenRow = QueryResultRow & {
  client_id: string;
  principal_id: string;
  scope: string;
  resource: string | null;
  quickbooks_connection_id: string;
  connection_status?: "active" | "needs_reauth" | "revoked" | "disconnected";
  expires_at: Date;
  revoked_at: Date | null;
};

export interface StoredQuickBooksConnection {
  id: string;
  principalId: string;
  realmId: string;
  environment: "sandbox" | "production";
  refreshTokenSecretId: string;
  scopes: string[];
  status: "active" | "needs_reauth" | "revoked" | "disconnected";
  companyName?: string;
}

export interface PendingAuthorization {
  intuitState: string;
  principalId: string;
  clientId: string;
  redirectUri: string;
  claudeState?: string;
  codeChallenge: string;
  requestedScope: string;
  resource?: string;
}

export interface CreateAuthorizationCodeInput {
  clientId: string;
  principalId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource?: string;
  quickbooksConnectionId: string;
}

export function createPrincipalId(): string {
  return `connector:${randomToken(18)}`;
}

export class MultipleActiveQuickBooksConnectionsError extends Error {
  constructor(principalId: string) {
    super(
      `Multiple active QuickBooks connections exist for principal ${principalId}`,
    );
    this.name = "MultipleActiveQuickBooksConnectionsError";
  }
}

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function mapClientRow(row: OAuthClientRow): OAuthClientInformationFull {
  return {
    client_id: row.client_id,
    client_secret: row.client_secret ?? undefined,
    redirect_uris: normalizeStringArray(row.redirect_uris),
    token_endpoint_auth_method: row.token_endpoint_auth_method,
    grant_types: normalizeStringArray(row.grant_types),
    response_types: normalizeStringArray(row.response_types),
    client_name: row.client_name ?? undefined,
    scope: row.scope ?? undefined,
    client_id_issued_at: row.client_id_issued_at,
    client_secret_expires_at: row.client_secret_expires_at ?? undefined,
  };
}

function mapConnectionRow(
  row: QuickBooksConnectionRow,
): StoredQuickBooksConnection {
  return {
    id: row.id,
    principalId: row.principal_id,
    realmId: row.realm_id,
    environment: row.environment,
    refreshTokenSecretId: row.refresh_token_secret_id,
    scopes: normalizeStringArray(row.scopes),
    status: row.status,
    companyName: row.company_name ?? undefined,
  };
}

export class ConnectorAuthStore {
  async getClient(
    clientId: string,
  ): Promise<OAuthClientInformationFull | undefined> {
    const row = await queryOne<OAuthClientRow>(
      `
        select
          client_id,
          client_secret,
          redirect_uris,
          token_endpoint_auth_method,
          grant_types,
          response_types,
          client_name,
          scope,
          client_id_issued_at,
          client_secret_expires_at
        from mcp_private.connector_oauth_clients
        where client_id = $1
      `,
      [clientId],
    );

    return row ? mapClientRow(row) : undefined;
  }

  async registerClient(
    client: Omit<
      OAuthClientInformationFull,
      "client_id" | "client_id_issued_at"
    > & {
      client_id: string;
      client_id_issued_at: number;
    },
  ): Promise<OAuthClientInformationFull> {
    let row: OAuthClientRow | null;
    try {
      row = await queryOne<OAuthClientRow>(
        `
          insert into mcp_private.connector_oauth_clients (
            client_id,
            client_secret,
            redirect_uris,
            token_endpoint_auth_method,
            grant_types,
            response_types,
            client_name,
            scope,
            client_id_issued_at,
            client_secret_expires_at
          ) values ($1, $2, $3::jsonb, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10)
          returning
            client_id,
            client_secret,
            redirect_uris,
            token_endpoint_auth_method,
            grant_types,
            response_types,
            client_name,
            scope,
            client_id_issued_at,
            client_secret_expires_at
        `,
        [
          client.client_id,
          client.client_secret ?? null,
          JSON.stringify(client.redirect_uris),
          client.token_endpoint_auth_method ?? "none",
          JSON.stringify(
            client.grant_types ?? ["authorization_code", "refresh_token"],
          ),
          JSON.stringify(client.response_types ?? ["code"]),
          client.client_name ?? null,
          client.scope ?? null,
          client.client_id_issued_at,
          client.client_secret_expires_at ?? null,
        ],
      );
    } catch (error) {
      console.error("[connector-auth] failed to register oauth client", {
        clientId: client.client_id,
        clientName: client.client_name,
        redirectUris: client.redirect_uris,
        tokenEndpointAuthMethod: client.token_endpoint_auth_method ?? "none",
        grantTypes: client.grant_types ?? [
          "authorization_code",
          "refresh_token",
        ],
        responseTypes: client.response_types ?? ["code"],
        scope: client.scope ?? null,
      });
      throw error;
    }

    if (!row) {
      throw new Error("Failed to store OAuth client registration");
    }

    return mapClientRow(row);
  }

  async createPendingAuthorization(
    input: Omit<PendingAuthorization, "intuitState">,
  ): Promise<string> {
    const intuitState = randomToken();
    await queryOne(
      `
        insert into mcp_private.connector_oauth_pending_authorizations (
          intuit_state,
          principal_id,
          client_id,
          redirect_uri,
          claude_state,
          code_challenge,
          requested_scope,
          resource,
          expires_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        returning intuit_state
      `,
      [
        intuitState,
        input.principalId,
        input.clientId,
        input.redirectUri,
        input.claudeState ?? null,
        input.codeChallenge,
        input.requestedScope,
        input.resource ?? null,
        new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS),
      ],
    );

    return intuitState;
  }

  async consumePendingAuthorization(
    intuitState: string,
  ): Promise<PendingAuthorization | null> {
    return withPgTransaction(async (client) => {
      const result = await client.query<PendingAuthorizationRow>(
        `
          delete from mcp_private.connector_oauth_pending_authorizations
          where intuit_state = $1
            and expires_at > now()
          returning
            intuit_state,
            principal_id,
            client_id,
            redirect_uri,
            claude_state,
            code_challenge,
            requested_scope,
            resource,
            expires_at
        `,
        [intuitState],
      );

      const row = result.rows[0];
      if (!row) {
        return null;
      }

      return {
        intuitState: row.intuit_state,
        principalId: row.principal_id,
        clientId: row.client_id,
        redirectUri: row.redirect_uri,
        claudeState: row.claude_state ?? undefined,
        codeChallenge: row.code_challenge,
        requestedScope: row.requested_scope,
        resource: row.resource ?? undefined,
      };
    });
  }

  async storeQuickBooksConnection(input: {
    principalId: string;
    realmId: string;
    environment: "sandbox" | "production";
    refreshToken: string;
    scopes: string[];
    companyName?: string;
  }): Promise<StoredQuickBooksConnection> {
    return withPgTransaction(async (client) => {
      const existingResult = await client.query<{
        refresh_token_secret_id: string;
      }>(
        `
          select refresh_token_secret_id
          from mcp_private.connector_quickbooks_connections
          where principal_id = $1
            and realm_id = $2
            and environment = $3
          for update
        `,
        [input.principalId, input.realmId, input.environment],
      );
      const previousSecretId = existingResult.rows[0]?.refresh_token_secret_id;

      const otherConnectionsResult = await client.query<{ id: string }>(
        `
          update mcp_private.connector_quickbooks_connections
          set status = 'disconnected',
              revoked_at = now(),
              updated_at = now()
          where principal_id = $1
            and not (realm_id = $2 and environment = $3)
            and status = 'active'
          returning id
        `,
        [input.principalId, input.realmId, input.environment],
      );

      for (const otherRow of otherConnectionsResult.rows) {
        await client.query(
          `
            update mcp_private.connector_oauth_access_tokens
            set revoked_at = now()
            where quickbooks_connection_id = $1::uuid
              and revoked_at is null
          `,
          [otherRow.id],
        );
        await client.query(
          `
            update mcp_private.connector_oauth_refresh_tokens
            set revoked_at = now()
            where quickbooks_connection_id = $1::uuid
              and revoked_at is null
          `,
          [otherRow.id],
        );
      }

      const secretResult = await client.query<{ id: string }>(
        `
          select vault.create_secret(
            $1,
            null,
            'QuickBooks refresh token for principal ' || $2 || ' realm ' || $3
          ) as id
        `,
        [input.refreshToken, input.principalId, input.realmId],
      );

      const refreshTokenSecretId = secretResult.rows[0]?.id;
      if (!refreshTokenSecretId) {
        throw new Error(
          "Failed to create Vault secret for QuickBooks refresh token",
        );
      }

      const connectionResult = await client.query<QuickBooksConnectionRow>(
        `
          insert into mcp_private.connector_quickbooks_connections (
            principal_id,
            realm_id,
            environment,
            refresh_token_secret_id,
            scopes,
            status,
            company_name,
            connected_at,
            revoked_at,
            last_refreshed_at,
            last_used_at
          ) values ($1, $2, $3, $4, $5::jsonb, 'active', $6, now(), null, null, null)
          on conflict (principal_id, realm_id, environment)
          do update set
            refresh_token_secret_id = excluded.refresh_token_secret_id,
            scopes = excluded.scopes,
            status = 'active',
            company_name = excluded.company_name,
            revoked_at = null,
            updated_at = now()
          returning id, principal_id, realm_id, environment, refresh_token_secret_id, scopes, status, company_name
        `,
        [
          input.principalId,
          input.realmId,
          input.environment,
          refreshTokenSecretId,
          JSON.stringify(input.scopes),
          input.companyName ?? null,
        ],
      );

      const row = connectionResult.rows[0];
      if (!row) {
        throw new Error("Failed to upsert QuickBooks connection");
      }

      if (previousSecretId && previousSecretId !== refreshTokenSecretId) {
        await client.query(`delete from vault.secrets where id = $1::uuid`, [
          previousSecretId,
        ]);
      }

      return mapConnectionRow(row);
    });
  }

  async rotateQuickBooksRefreshToken(input: {
    connectionId: string;
    principalId: string;
    realmId: string;
    refreshToken: string;
  }): Promise<void> {
    await withPgTransaction(async (client) => {
      const currentResult = await client.query<{
        refresh_token_secret_id: string;
      }>(
        `
          select refresh_token_secret_id
          from mcp_private.connector_quickbooks_connections
          where id = $1::uuid
            and principal_id = $2
            and realm_id = $3
          for update
        `,
        [input.connectionId, input.principalId, input.realmId],
      );

      const currentSecretId = currentResult.rows[0]?.refresh_token_secret_id;
      if (!currentSecretId) {
        throw new Error(
          "QuickBooks connection not found for refresh token rotation",
        );
      }

      const nextSecretResult = await client.query<{ id: string }>(
        `
          select vault.create_secret(
            $1,
            null,
            'QuickBooks refresh token for principal ' || $2 || ' realm ' || $3
          ) as id
        `,
        [input.refreshToken, input.principalId, input.realmId],
      );

      const nextSecretId = nextSecretResult.rows[0]?.id;
      if (!nextSecretId) {
        throw new Error("Failed to create replacement Vault secret");
      }

      await client.query(
        `
          update mcp_private.connector_quickbooks_connections
          set refresh_token_secret_id = $2::uuid,
              updated_at = now()
          where id = $1::uuid
        `,
        [input.connectionId, nextSecretId],
      );

      await client.query(`delete from vault.secrets where id = $1::uuid`, [
        currentSecretId,
      ]);
    });
  }

  async getActiveQuickBooksConnection(
    principalId: string,
  ): Promise<StoredQuickBooksConnection | null> {
    const rows = await queryRows<QuickBooksConnectionRow>(
      `
        select id, principal_id, realm_id, environment, refresh_token_secret_id, scopes, status, company_name
        from mcp_private.connector_quickbooks_connections
        where principal_id = $1
          and status = 'active'
        order by updated_at desc
        limit 2
      `,
      [principalId],
    );

    if (rows.length > 1) {
      throw new MultipleActiveQuickBooksConnectionsError(principalId);
    }

    const row = rows[0];
    return row ? mapConnectionRow(row) : null;
  }

  async getRefreshToken(secretId: string): Promise<string> {
    const row = await queryOne<{ decrypted_secret: string }>(
      `
        select decrypted_secret
        from vault.decrypted_secrets
        where id = $1
      `,
      [secretId],
    );

    if (!row?.decrypted_secret) {
      throw new Error("QuickBooks refresh token secret not found");
    }

    return row.decrypted_secret;
  }

  async markConnectionUsed(
    connectionId: string,
    didRefreshToken: boolean,
  ): Promise<void> {
    await queryOne(
      `
        update mcp_private.connector_quickbooks_connections
        set
          last_used_at = now(),
          last_refreshed_at = case when $2 then now() else last_refreshed_at end,
          updated_at = now()
        where id = $1
      `,
      [connectionId, didRefreshToken],
    );
  }

  async updateConnectionStatus(input: {
    connectionId: string;
    status: "active" | "needs_reauth" | "revoked" | "disconnected";
  }): Promise<void> {
    await queryOne(
      `
        update mcp_private.connector_quickbooks_connections
        set
          status = $2,
          revoked_at = case when $2 in ('revoked', 'disconnected') then now() else revoked_at end,
          updated_at = now()
        where id = $1::uuid
      `,
      [input.connectionId, input.status],
    );
  }

  async revokeTokensForConnection(connectionId: string): Promise<void> {
    await withPgTransaction(async (client) => {
      await client.query(
        `
          update mcp_private.connector_oauth_access_tokens
          set revoked_at = now()
          where quickbooks_connection_id = $1::uuid
            and revoked_at is null
        `,
        [connectionId],
      );

      await client.query(
        `
          update mcp_private.connector_oauth_refresh_tokens
          set revoked_at = now()
          where quickbooks_connection_id = $1::uuid
            and revoked_at is null
        `,
        [connectionId],
      );
    });
  }

  async writeAuditEvent(input: {
    requestId?: string;
    principalId: string;
    connectionId?: string;
    realmId?: string;
    toolName: string;
    actionType: "read" | "write";
    decision: "allowed" | "denied";
    outcome: "success" | "failure";
    errorCode?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await queryOne(
      `
        insert into mcp_private.connector_quickbooks_audit_events (
          request_id,
          principal_id,
          connection_id,
          realm_id,
          tool_name,
          action_type,
          decision,
          outcome,
          error_code,
          metadata
        ) values ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10::jsonb)
      `,
      [
        input.requestId ?? null,
        input.principalId,
        input.connectionId ?? null,
        input.realmId ?? null,
        input.toolName,
        input.actionType,
        input.decision,
        input.outcome,
        input.errorCode ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  }

  async createAuthorizationCode(
    input: CreateAuthorizationCodeInput,
  ): Promise<string> {
    const code = randomToken();
    await queryOne(
      `
        insert into mcp_private.connector_oauth_authorization_codes (
          code_hash,
          client_id,
          principal_id,
          redirect_uri,
          code_challenge,
          scope,
          resource,
          quickbooks_connection_id,
          expires_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8::uuid, $9)
      `,
      [
        hashToken(code),
        input.clientId,
        input.principalId,
        input.redirectUri,
        input.codeChallenge,
        input.scope,
        input.resource ?? null,
        input.quickbooksConnectionId,
        new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS),
      ],
    );

    return code;
  }

  async getAuthorizationCodeChallenge(
    clientId: string,
    code: string,
  ): Promise<string> {
    const row = await queryOne<AuthorizationCodeRow>(
      `
        select client_id, principal_id, redirect_uri, code_challenge, scope, resource, quickbooks_connection_id, expires_at, consumed_at
        from mcp_private.connector_oauth_authorization_codes
        where code_hash = $1
      `,
      [hashToken(code)],
    );

    if (
      !row ||
      row.client_id !== clientId ||
      row.consumed_at ||
      row.expires_at <= new Date()
    ) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }

    return row.code_challenge;
  }

  async exchangeAuthorizationCode(input: {
    clientId: string;
    code: string;
    redirectUri?: string;
    resource?: string;
  }): Promise<OAuthTokens> {
    return withPgTransaction(async (client) => {
      const row = await this.getAuthorizationCodeForUpdate(client, input.code);
      if (!row || row.client_id !== input.clientId) {
        throw new InvalidGrantError("Invalid authorization code");
      }
      if (row.connection_status && row.connection_status !== "active") {
        throw new InvalidGrantError("QuickBooks connection is not active");
      }
      if (row.consumed_at || row.expires_at <= new Date()) {
        throw new InvalidGrantError(
          "Authorization code is expired or already consumed",
        );
      }
      if (input.redirectUri && input.redirectUri !== row.redirect_uri) {
        throw new InvalidGrantError(
          "Authorization code redirect URI does not match",
        );
      }
      if ((input.resource ?? null) !== row.resource) {
        throw new InvalidGrantError(
          "Authorization code resource does not match",
        );
      }

      await client.query(
        `
          update mcp_private.connector_oauth_authorization_codes
          set consumed_at = now()
          where code_hash = $1
        `,
        [hashToken(input.code)],
      );

      const accessToken = await this.insertAccessToken(client, {
        clientId: row.client_id,
        principalId: row.principal_id,
        scope: row.scope,
        resource: row.resource ?? undefined,
        quickbooksConnectionId: row.quickbooks_connection_id,
      });

      const refreshToken = await this.insertRefreshToken(client, {
        clientId: row.client_id,
        principalId: row.principal_id,
        scope: row.scope,
        resource: row.resource ?? undefined,
        quickbooksConnectionId: row.quickbooks_connection_id,
      });

      return {
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_MS / 1000,
        scope: row.scope || undefined,
      };
    });
  }

  async exchangeRefreshToken(input: {
    clientId: string;
    refreshToken: string;
    scope?: string[];
    resource?: string;
  }): Promise<OAuthTokens> {
    return withPgTransaction(async (client) => {
      const row = await this.getRefreshTokenForUpdate(
        client,
        input.refreshToken,
      );
      if (!row || row.client_id !== input.clientId) {
        throw new InvalidGrantError("Invalid refresh token");
      }
      if (row.connection_status && row.connection_status !== "active") {
        throw new InvalidGrantError("QuickBooks connection is not active");
      }
      if (row.revoked_at || row.expires_at <= new Date()) {
        throw new InvalidGrantError("Refresh token is expired or revoked");
      }

      const requestedScope = input.scope?.join(" ") ?? row.scope;
      if (input.scope && requestedScope !== row.scope) {
        throw new InvalidGrantError(
          "Refresh token scope escalation is not allowed",
        );
      }
      if ((input.resource ?? null) !== row.resource) {
        throw new InvalidGrantError("Refresh token resource does not match");
      }

      await client.query(
        `
          update mcp_private.connector_oauth_refresh_tokens
          set revoked_at = now()
          where token_hash = $1
        `,
        [hashToken(input.refreshToken)],
      );

      const accessToken = await this.insertAccessToken(client, {
        clientId: row.client_id,
        principalId: row.principal_id,
        scope: row.scope,
        resource: row.resource ?? undefined,
        quickbooksConnectionId: row.quickbooks_connection_id,
      });

      const refreshToken = await this.insertRefreshToken(client, {
        clientId: row.client_id,
        principalId: row.principal_id,
        scope: row.scope,
        resource: row.resource ?? undefined,
        quickbooksConnectionId: row.quickbooks_connection_id,
      });

      return {
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_MS / 1000,
        scope: row.scope || undefined,
      };
    });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = await queryOne<AccessTokenRow>(
      `
        select
          tokens.client_id,
          tokens.principal_id,
          tokens.scope,
          tokens.resource,
          tokens.quickbooks_connection_id,
          tokens.expires_at,
          tokens.revoked_at,
          qc.status as connection_status
        from mcp_private.connector_oauth_access_tokens tokens
        join mcp_private.connector_quickbooks_connections qc
          on qc.id = tokens.quickbooks_connection_id
        where token_hash = $1
      `,
      [hashToken(token)],
    );

    if (!row || row.revoked_at || row.expires_at <= new Date()) {
      throw new InvalidTokenError("Invalid access token");
    }
    if (row.connection_status && row.connection_status !== "active") {
      throw new InvalidTokenError("QuickBooks connection is not active");
    }

    return {
      token,
      clientId: row.client_id,
      scopes: row.scope ? row.scope.split(" ") : [],
      expiresAt: Math.floor(row.expires_at.getTime() / 1000),
      resource: row.resource ? new URL(row.resource) : undefined,
      extra: {
        principalId: row.principal_id,
        quickbooksConnectionId: row.quickbooks_connection_id,
      },
    };
  }

  async revokeOAuthToken(token: string): Promise<void> {
    const hashed = hashToken(token);
    await withPgTransaction(async (client) => {
      await client.query(
        `update mcp_private.connector_oauth_access_tokens set revoked_at = now() where token_hash = $1`,
        [hashed],
      );
      await client.query(
        `update mcp_private.connector_oauth_refresh_tokens set revoked_at = now() where token_hash = $1`,
        [hashed],
      );
    });
  }

  private async getAuthorizationCodeForUpdate(
    client: PoolClient,
    code: string,
  ): Promise<AuthorizationCodeRow | null> {
    const result = await client.query<AuthorizationCodeRow>(
      `
        select
          codes.client_id,
          codes.principal_id,
          codes.redirect_uri,
          codes.code_challenge,
          codes.scope,
          codes.resource,
          codes.quickbooks_connection_id,
          codes.expires_at,
          codes.consumed_at,
          qc.status as connection_status
        from mcp_private.connector_oauth_authorization_codes codes
        join mcp_private.connector_quickbooks_connections qc
          on qc.id = codes.quickbooks_connection_id
        where code_hash = $1
        for update
      `,
      [hashToken(code)],
    );

    return result.rows[0] ?? null;
  }

  private async getRefreshTokenForUpdate(
    client: PoolClient,
    refreshToken: string,
  ): Promise<RefreshTokenRow | null> {
    const result = await client.query<RefreshTokenRow>(
      `
        select
          tokens.client_id,
          tokens.principal_id,
          tokens.scope,
          tokens.resource,
          tokens.quickbooks_connection_id,
          tokens.expires_at,
          tokens.revoked_at,
          qc.status as connection_status
        from mcp_private.connector_oauth_refresh_tokens tokens
        join mcp_private.connector_quickbooks_connections qc
          on qc.id = tokens.quickbooks_connection_id
        where token_hash = $1
        for update
      `,
      [hashToken(refreshToken)],
    );

    return result.rows[0] ?? null;
  }

  private async insertAccessToken(
    client: PoolClient,
    input: {
      clientId: string;
      principalId: string;
      scope: string;
      resource?: string;
      quickbooksConnectionId: string;
    },
  ): Promise<string> {
    const token = randomToken();
    await client.query(
      `
        insert into mcp_private.connector_oauth_access_tokens (
          token_hash,
          client_id,
          principal_id,
          scope,
          resource,
          quickbooks_connection_id,
          expires_at
        ) values ($1, $2, $3, $4, $5, $6::uuid, $7)
      `,
      [
        hashToken(token),
        input.clientId,
        input.principalId,
        input.scope,
        input.resource ?? null,
        input.quickbooksConnectionId,
        new Date(Date.now() + ACCESS_TOKEN_TTL_MS),
      ],
    );
    return token;
  }

  private async insertRefreshToken(
    client: PoolClient,
    input: {
      clientId: string;
      principalId: string;
      scope: string;
      resource?: string;
      quickbooksConnectionId: string;
    },
  ): Promise<string> {
    const token = randomToken();
    await client.query(
      `
        insert into mcp_private.connector_oauth_refresh_tokens (
          token_hash,
          client_id,
          principal_id,
          scope,
          resource,
          quickbooks_connection_id,
          expires_at
        ) values ($1, $2, $3, $4, $5, $6::uuid, $7)
      `,
      [
        hashToken(token),
        input.clientId,
        input.principalId,
        input.scope,
        input.resource ?? null,
        input.quickbooksConnectionId,
        new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      ],
    );
    return token;
  }
}

export const connectorAuthStore = new ConnectorAuthStore();
