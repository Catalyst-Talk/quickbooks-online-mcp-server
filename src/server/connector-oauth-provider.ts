import type { Request, Response } from "express";
import crypto from "node:crypto";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import OAuthClient from "intuit-oauth";
import {
  buildQuickBooksAuthorizationUrl,
  exchangeQuickBooksCallback,
  invalidateConnectorTokenCache,
} from "../clients/quickbooks-client.js";
import {
  connectorAuthStore,
  createPrincipalId,
  MultipleActiveQuickBooksConnectionsError,
  type StoredQuickBooksConnection,
} from "../storage/connector-auth-store.js";

const DEFAULT_MCP_SCOPE = "mcp mcp:read";
const REQUIRED_CONNECTOR_SCOPES = ["mcp", "mcp:read"] as const;

function getEffectiveRequestedScope(scopes?: string[]): string {
  if (!scopes?.length) {
    return DEFAULT_MCP_SCOPE;
  }

  return Array.from(
    new Set([
      ...REQUIRED_CONNECTOR_SCOPES,
      ...scopes.map((scope) => scope.trim()).filter(Boolean),
    ]),
  ).join(" ");
}

function getPublicBaseUrl(): URL {
  const baseUrl = process.env.MCP_PUBLIC_BASE_URL;
  if (!baseUrl) {
    throw new Error("MCP_PUBLIC_BASE_URL is required for connector auth mode");
  }

  return new URL(baseUrl);
}

function getQuickBooksEnvironment(): "sandbox" | "production" {
  return process.env.QUICKBOOKS_ENVIRONMENT === "production"
    ? "production"
    : "sandbox";
}

function getQuickBooksCallbackUrl(): string {
  return new URL("/oauth/quickbooks/callback", getPublicBaseUrl()).toString();
}

const CONNECTOR_PRINCIPAL_COOKIE = "mcp_connector_principal";

function getConnectorCookieSecret(): string {
  const secret = process.env.MCP_CONNECTOR_COOKIE_SECRET;
  if (!secret) {
    throw new Error(
      "MCP_CONNECTOR_COOKIE_SECRET is required for connector auth mode",
    );
  }

  return secret;
}

function signPrincipalId(principalId: string): string {
  return crypto
    .createHmac("sha256", getConnectorCookieSecret())
    .update(principalId)
    .digest("base64url");
}

function serializePrincipalCookie(principalId: string): string {
  const signature = signPrincipalId(principalId);
  const secure = getPublicBaseUrl().protocol === "https:" ? "; Secure" : "";
  return `${CONNECTOR_PRINCIPAL_COOKIE}=${encodeURIComponent(`${principalId}.${signature}`)}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

function parseCookieHeader(cookieHeader?: string): Record<string, string> {
  return (cookieHeader || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, part) => {
      const [name, ...rest] = part.split("=");
      if (!name) {
        return acc;
      }
      acc[name] = decodeURIComponent(rest.join("="));
      return acc;
    }, {});
}

function getOrCreateConnectorPrincipalId(req: Request, res: Response): string {
  const cookies = parseCookieHeader(req.headers.cookie);
  const cookieValue = cookies[CONNECTOR_PRINCIPAL_COOKIE];
  if (cookieValue) {
    const lastDot = cookieValue.lastIndexOf(".");
    if (lastDot > 0) {
      const principalId = cookieValue.slice(0, lastDot);
      const signature = cookieValue.slice(lastDot + 1);
      if (signature === signPrincipalId(principalId)) {
        return principalId;
      }
    }
  }

  const principalId = createPrincipalId();
  res.setHeader("Set-Cookie", serializePrincipalCookie(principalId));
  return principalId;
}

function getPrincipalIdFromRequest(req: Request): string {
  const principalId = req.auth?.extra?.principalId;
  if (typeof principalId !== "string" || principalId.length === 0) {
    throw new Error("No authenticated connector principal on request");
  }

  return principalId;
}

function queryToSearchParams(query: Request["query"]): URLSearchParams {
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string") {
      searchParams.append(key, value);
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          searchParams.append(key, item);
        }
      }
    }
  }

  return searchParams;
}

class ConnectorOAuthClientsStore implements OAuthRegisteredClientsStore {
  async getClient(
    clientId: string,
  ): Promise<OAuthClientInformationFull | undefined> {
    return connectorAuthStore.getClient(clientId);
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
    return connectorAuthStore.registerClient(client);
  }
}

export class ConnectorOAuthServerProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;

  constructor() {
    this.clientsStore = new ConnectorOAuthClientsStore();
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const req = res.req as Request | undefined;
    if (!req) {
      throw new Error("Authorize flow is missing the originating request");
    }

    const intuitState = await connectorAuthStore.createPendingAuthorization({
      principalId: getOrCreateConnectorPrincipalId(req, res),
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      claudeState: params.state,
      codeChallenge: params.codeChallenge,
      requestedScope: getEffectiveRequestedScope(params.scopes),
      resource: params.resource?.href,
    });

    const authUrl = buildQuickBooksAuthorizationUrl({
      state: intuitState,
      redirectUri: getQuickBooksCallbackUrl(),
    });

    res.redirect(302, authUrl);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    return connectorAuthStore.getAuthorizationCodeChallenge(
      client.client_id,
      authorizationCode,
    );
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    return connectorAuthStore.exchangeAuthorizationCode({
      clientId: client.client_id,
      code: authorizationCode,
      redirectUri,
      resource: resource?.href,
    });
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    return connectorAuthStore.exchangeRefreshToken({
      clientId: client.client_id,
      refreshToken,
      scope: scopes,
      resource: resource?.href,
    });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    return connectorAuthStore.verifyAccessToken(token);
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    await connectorAuthStore.revokeOAuthToken(request.token);
  }
}

export async function handleQuickBooksOAuthCallback(
  req: Request,
  res: Response,
): Promise<void> {
  const state =
    typeof req.query.state === "string" ? req.query.state : undefined;
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const realmId =
    typeof req.query.realmId === "string" ? req.query.realmId : undefined;

  if (!state || !code || !realmId) {
    res
      .status(400)
      .json({ error: "Missing QuickBooks OAuth callback parameters" });
    return;
  }

  const pendingAuthorization =
    await connectorAuthStore.consumePendingAuthorization(state);
  if (!pendingAuthorization) {
    res
      .status(400)
      .json({ error: "Invalid or expired QuickBooks OAuth state" });
    return;
  }

  const callbackUrl = new URL("/oauth/quickbooks/callback", getPublicBaseUrl());
  callbackUrl.search = queryToSearchParams(req.query).toString();

  const tokenResponse = await exchangeQuickBooksCallback(
    callbackUrl.toString(),
    {
      redirectUri: getQuickBooksCallbackUrl(),
    },
  );

  if (!tokenResponse.refresh_token || !tokenResponse.realmId) {
    res.status(502).json({
      error: "QuickBooks token response missing refresh token or realm ID",
    });
    return;
  }

  const principalId = pendingAuthorization.principalId;
  let connection: StoredQuickBooksConnection | null = null;
  let authorizationCode: string | null = null;
  try {
    connection = await connectorAuthStore.storeQuickBooksConnection({
      principalId,
      realmId: tokenResponse.realmId,
      environment: getQuickBooksEnvironment(),
      refreshToken: tokenResponse.refresh_token,
      scopes: [OAuthClient.scopes.Accounting as string],
    });

    authorizationCode = await connectorAuthStore.createAuthorizationCode({
      clientId: pendingAuthorization.clientId,
      principalId,
      redirectUri: pendingAuthorization.redirectUri,
      codeChallenge: pendingAuthorization.codeChallenge,
      scope: pendingAuthorization.requestedScope || DEFAULT_MCP_SCOPE,
      resource: pendingAuthorization.resource,
      quickbooksConnectionId: connection.id,
    });

    await connectorAuthStore.writeAuditEvent({
      principalId,
      connectionId: connection.id,
      realmId: connection.realmId,
      toolName: "oauth_callback",
      actionType: "write",
      decision: "allowed",
      outcome: "success",
    });
  } catch (error) {
    if (connection) {
      invalidateConnectorTokenCache(connection.id);
      await connectorAuthStore.updateConnectionStatus({
        connectionId: connection.id,
        status: "disconnected",
      });
      await connectorAuthStore.revokeTokensForConnection(connection.id);
      await connectorAuthStore.writeAuditEvent({
        principalId,
        connectionId: connection.id,
        realmId: connection.realmId,
        toolName: "oauth_callback",
        actionType: "write",
        decision: "allowed",
        outcome: "failure",
        errorCode: error instanceof Error ? error.message : "callback_failed",
      });
    }
    throw error;
  }

  if (!authorizationCode || !connection) {
    res
      .status(500)
      .json({ error: "Failed to complete connector authorization" });
    return;
  }

  const redirectUrl = new URL(pendingAuthorization.redirectUri);
  redirectUrl.searchParams.set("code", authorizationCode);
  if (pendingAuthorization.claudeState) {
    redirectUrl.searchParams.set("state", pendingAuthorization.claudeState);
  }

  res.setHeader("Set-Cookie", serializePrincipalCookie(principalId));

  res.redirect(302, redirectUrl.toString());
}

export async function handleQuickBooksStatus(
  req: Request,
  res: Response,
): Promise<void> {
  const principalId = getPrincipalIdFromRequest(req);
  let connection: StoredQuickBooksConnection | null;
  try {
    connection =
      await connectorAuthStore.getActiveQuickBooksConnection(principalId);
  } catch (error) {
    if (error instanceof MultipleActiveQuickBooksConnectionsError) {
      res.status(409).json({ error: error.message });
      return;
    }
    throw error;
  }

  res.status(200).json({
    connected: Boolean(connection),
    principalId,
    connection: connection
      ? {
          id: connection.id,
          realmId: connection.realmId,
          environment: connection.environment,
          status: connection.status,
          companyName: connection.companyName,
        }
      : null,
  });
}

export async function handleQuickBooksDisconnect(
  req: Request,
  res: Response,
): Promise<void> {
  const principalId = getPrincipalIdFromRequest(req);
  let connection: StoredQuickBooksConnection | null;
  try {
    connection =
      await connectorAuthStore.getActiveQuickBooksConnection(principalId);
  } catch (error) {
    if (error instanceof MultipleActiveQuickBooksConnectionsError) {
      res.status(409).json({ error: error.message });
      return;
    }
    throw error;
  }

  if (!connection) {
    res
      .status(404)
      .json({ error: "No active QuickBooks connection for current principal" });
    return;
  }

  await connectorAuthStore.updateConnectionStatus({
    connectionId: connection.id,
    status: "disconnected",
  });
  invalidateConnectorTokenCache(connection.id);
  await connectorAuthStore.revokeTokensForConnection(connection.id);
  await connectorAuthStore.writeAuditEvent({
    principalId,
    connectionId: connection.id,
    realmId: connection.realmId,
    toolName: "oauth_disconnect",
    actionType: "write",
    decision: "allowed",
    outcome: "success",
  });

  res.status(200).json({ disconnected: true });
}

export async function handleQuickBooksStart(
  req: Request,
  res: Response,
): Promise<void> {
  const search = queryToSearchParams(req.query);

  const authorizeUrl = new URL("/authorize", getPublicBaseUrl());
  authorizeUrl.search = search.toString();
  res.redirect(302, authorizeUrl.toString());
}
