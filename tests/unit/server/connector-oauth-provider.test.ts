import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

const buildQuickBooksAuthorizationUrlMock = jest.fn<
  (_input: { state: string; redirectUri?: string }) => string
>(() => "https://quickbooks.example.com/oauth");
const exchangeQuickBooksCallbackMock = jest.fn<
  (_callbackUrl: string, _options?: { redirectUri?: string }) => Promise<unknown>
>();
const invalidateConnectorTokenCacheMock = jest.fn<
  (_connectionId: string) => void
>();
const createPrincipalIdMock = jest.fn<() => string>(
  () => "connector:test-principal",
);
const createPendingAuthorizationMock = jest.fn<
  (_input: unknown) => Promise<string>
>();
const getAuthorizationCodeChallengeMock = jest.fn<
  (_clientId: string, _authorizationCode: string) => Promise<string>
>();
const exchangeAuthorizationCodeMock = jest.fn<
  (_input: unknown) => Promise<unknown>
>();
const exchangeRefreshTokenMock = jest.fn<
  (_input: unknown) => Promise<unknown>
>();
const verifyAccessTokenMock = jest.fn<(_token: string) => Promise<unknown>>();
const revokeOAuthTokenMock = jest.fn<(_token: string) => Promise<void>>();
const getClientMock = jest.fn<(_clientId: string) => Promise<unknown>>();
const registerClientMock = jest.fn<(_client: unknown) => Promise<unknown>>();
const consumePendingAuthorizationMock = jest.fn<
  (_state: string) => Promise<unknown>
>();
const storeQuickBooksConnectionMock = jest.fn<
  (_input: unknown) => Promise<unknown>
>();
const createAuthorizationCodeMock = jest.fn<
  (_input: unknown) => Promise<unknown>
>();
const writeAuditEventMock = jest.fn<(_input: unknown) => Promise<void>>();
const updateConnectionStatusMock = jest.fn<(_input: unknown) => Promise<void>>();
const revokeTokensForConnectionMock = jest.fn<
  (_connectionId: string) => Promise<void>
>();
const getActiveQuickBooksConnectionMock = jest.fn<
  (_principalId: string) => Promise<unknown>
>();

class MultipleActiveQuickBooksConnectionsError extends Error {
  constructor(principalId: string) {
    super(
      `Multiple active QuickBooks connections exist for principal ${principalId}`,
    );
  }
}

const connectorAuthStoreMock = {
  createPendingAuthorization: createPendingAuthorizationMock,
  getAuthorizationCodeChallenge: getAuthorizationCodeChallengeMock,
  exchangeAuthorizationCode: exchangeAuthorizationCodeMock,
  exchangeRefreshToken: exchangeRefreshTokenMock,
  verifyAccessToken: verifyAccessTokenMock,
  revokeOAuthToken: revokeOAuthTokenMock,
  getClient: getClientMock,
  registerClient: registerClientMock,
  consumePendingAuthorization: consumePendingAuthorizationMock,
  storeQuickBooksConnection: storeQuickBooksConnectionMock,
  createAuthorizationCode: createAuthorizationCodeMock,
  writeAuditEvent: writeAuditEventMock,
  updateConnectionStatus: updateConnectionStatusMock,
  revokeTokensForConnection: revokeTokensForConnectionMock,
  getActiveQuickBooksConnection: getActiveQuickBooksConnectionMock,
};

jest.unstable_mockModule("../../../src/clients/quickbooks-client", () => ({
  buildQuickBooksAuthorizationUrl: buildQuickBooksAuthorizationUrlMock,
  exchangeQuickBooksCallback: exchangeQuickBooksCallbackMock,
  invalidateConnectorTokenCache: invalidateConnectorTokenCacheMock,
}));

jest.unstable_mockModule("../../../src/storage/connector-auth-store", () => ({
  connectorAuthStore: connectorAuthStoreMock,
  createPrincipalId: createPrincipalIdMock,
  MultipleActiveQuickBooksConnectionsError,
}));

const {
  ConnectorOAuthServerProvider,
  handleQuickBooksDisconnect,
  handleQuickBooksOAuthCallback,
  handleQuickBooksStart,
  handleQuickBooksStatus,
} = await import("../../../src/server/connector-oauth-provider");

function createAuthorizeResponse(cookieHeader?: string) {
  return {
    req: {
      headers: cookieHeader
        ? { cookie: cookieHeader }
        : {},
    },
    setHeader: jest.fn(),
    redirect: jest.fn(),
  } as any;
}

function createJsonResponse() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
    redirect: jest.fn(),
  } as any;
}

function createSignedCookie(principalId: string, secret: string) {
  const signature = crypto
    .createHmac("sha256", secret)
    .update(principalId)
    .digest("base64url");

  return `=ignored; mcp_connector_principal=${encodeURIComponent(`${principalId}.${signature}`)}`;
}

let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;

describe("ConnectorOAuthServerProvider", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    process.env.MCP_PUBLIC_BASE_URL = "https://quickbooks.example.com";
    process.env.MCP_CONNECTOR_COOKIE_SECRET = "test-cookie-secret";
    process.env.QUICKBOOKS_ENVIRONMENT = "sandbox";

    createPendingAuthorizationMock.mockResolvedValue("intuit-state");
    getAuthorizationCodeChallengeMock.mockResolvedValue("pkce-challenge");
    exchangeAuthorizationCodeMock.mockResolvedValue({
      access_token: "access-token",
    });
    exchangeRefreshTokenMock.mockResolvedValue({
      access_token: "refreshed-access-token",
    });
    verifyAccessTokenMock.mockResolvedValue({
      token: "verified-token",
    });
    revokeOAuthTokenMock.mockResolvedValue(undefined);
    getClientMock.mockResolvedValue({
      client_id: "registered-client",
    });
    registerClientMock.mockImplementation(async (client) => client);
    consumePendingAuthorizationMock.mockResolvedValue({
      principalId: "connector:test-principal",
      clientId: "claude-client",
      redirectUri: "https://claude.example.com/oauth/callback",
      claudeState: "claude-state",
      codeChallenge: "pkce-challenge",
      requestedScope: "mcp mcp:read",
      resource: "https://quickbooks.example.com/mcp",
    });
    storeQuickBooksConnectionMock.mockResolvedValue({
      id: "connection-123",
      principalId: "connector:test-principal",
      realmId: "realm-123",
      environment: "sandbox",
      refreshTokenSecretId: "secret-123",
      scopes: ["com.intuit.quickbooks.accounting"],
      status: "active",
      companyName: "Acme Corp",
    });
    createAuthorizationCodeMock.mockResolvedValue("authorization-code");
    writeAuditEventMock.mockResolvedValue(undefined);
    updateConnectionStatusMock.mockResolvedValue(undefined);
    revokeTokensForConnectionMock.mockResolvedValue(undefined);
    getActiveQuickBooksConnectionMock.mockResolvedValue(null);

    exchangeQuickBooksCallbackMock.mockResolvedValue({
      refresh_token: "quickbooks-refresh-token",
      realmId: "realm-123",
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("proxies OAuth client registration store methods", async () => {
    const provider = new ConnectorOAuthServerProvider();

    await expect(provider.clientsStore.getClient("client-123")).resolves.toEqual({
      client_id: "registered-client",
    });
    expect(connectorAuthStoreMock.getClient).toHaveBeenCalledWith("client-123");

    await expect(
      provider.clientsStore.registerClient!({
        client_id: "client-123",
        client_id_issued_at: 123,
      } as any),
    ).resolves.toEqual({
      client_id: "client-123",
      client_id_issued_at: 123,
    });
  });

  it("throws when authorize is missing the originating request", async () => {
    const provider = new ConnectorOAuthServerProvider();

    await expect(
      provider.authorize(
        { client_id: "claude-client" } as any,
        {
          redirectUri: "https://claude.example.com/oauth/callback",
          state: "claude-state",
          codeChallenge: "pkce-challenge",
        } as any,
        {
          setHeader: jest.fn(),
          redirect: jest.fn(),
        } as any,
      ),
    ).rejects.toThrow("Authorize flow is missing the originating request");
  });

  it("uses the default read-capable scope and sets a secure cookie for https", async () => {
    const provider = new ConnectorOAuthServerProvider();
    const response = createAuthorizeResponse();

    await provider.authorize(
      { client_id: "claude-client" } as any,
      {
        redirectUri: "https://claude.example.com/oauth/callback",
        state: "claude-state",
        codeChallenge: "pkce-challenge",
      } as any,
      response,
    );

    expect(connectorAuthStoreMock.createPendingAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        principalId: "connector:test-principal",
        requestedScope: "mcp mcp:read",
      }),
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      "Set-Cookie",
      expect.stringContaining("Secure"),
    );
    expect(response.redirect).toHaveBeenCalledWith(
      302,
      "https://quickbooks.example.com/oauth",
    );
  });

  it("reuses a signed principal cookie and keeps write scope when requested", async () => {
    process.env.MCP_PUBLIC_BASE_URL = "http://quickbooks.example.com";
    const provider = new ConnectorOAuthServerProvider();
    const response = createAuthorizeResponse(
      createSignedCookie("connector:existing-principal", "test-cookie-secret"),
    );

    await provider.authorize(
      { client_id: "claude-client" } as any,
      {
        redirectUri: "https://claude.example.com/oauth/callback",
        state: "claude-state",
        codeChallenge: "pkce-challenge",
        scopes: ["mcp", "mcp:write", "mcp:read", "mcp:write"],
      } as any,
      response,
    );

    expect(connectorAuthStoreMock.createPendingAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        principalId: "connector:existing-principal",
        requestedScope: "mcp mcp:read mcp:write",
      }),
    );
    expect(response.setHeader).not.toHaveBeenCalled();
    expect(createPrincipalIdMock).not.toHaveBeenCalled();
  });

  it("ignores an invalid cookie signature and issues a non-secure cookie for http", async () => {
    process.env.MCP_PUBLIC_BASE_URL = "http://quickbooks.example.com";
    const provider = new ConnectorOAuthServerProvider();
    const response = createAuthorizeResponse(
      "mcp_connector_principal=connector%3Aexisting-principal.invalid-signature",
    );

    await provider.authorize(
      { client_id: "claude-client" } as any,
      {
        redirectUri: "https://claude.example.com/oauth/callback",
        state: "claude-state",
        codeChallenge: "pkce-challenge",
        scopes: ["mcp"],
      } as any,
      response,
    );

    expect(createPendingAuthorizationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        principalId: "connector:test-principal",
        requestedScope: "mcp mcp:read",
      }),
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      "Set-Cookie",
      expect.not.stringContaining("Secure"),
    );
  });

  it("replaces a malformed cookie value that is missing a signature delimiter", async () => {
    const provider = new ConnectorOAuthServerProvider();
    const response = createAuthorizeResponse(
      "mcp_connector_principal=connector%3Aexisting-principal",
    );

    await provider.authorize(
      { client_id: "claude-client" } as any,
      {
        redirectUri: "https://claude.example.com/oauth/callback",
        state: "claude-state",
        codeChallenge: "pkce-challenge",
      } as any,
      response,
    );

    expect(createPendingAuthorizationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        principalId: "connector:test-principal",
      }),
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      "Set-Cookie",
      expect.stringContaining("Secure"),
    );
  });

  it("fails fast when the connector cookie secret is missing", async () => {
    delete process.env.MCP_CONNECTOR_COOKIE_SECRET;
    const provider = new ConnectorOAuthServerProvider();

    await expect(
      provider.authorize(
        { client_id: "claude-client" } as any,
        {
          redirectUri: "https://claude.example.com/oauth/callback",
          state: "claude-state",
          codeChallenge: "pkce-challenge",
          scopes: ["mcp"],
        } as any,
        createAuthorizeResponse(),
      ),
    ).rejects.toThrow(
      "MCP_CONNECTOR_COOKIE_SECRET is required for connector auth mode",
    );
  });

  it("proxies authorization and token operations to the auth store", async () => {
    const provider = new ConnectorOAuthServerProvider();

    await expect(
      provider.challengeForAuthorizationCode(
        { client_id: "claude-client" } as any,
        "authorization-code",
      ),
    ).resolves.toBe("pkce-challenge");
    expect(
      connectorAuthStoreMock.getAuthorizationCodeChallenge,
    ).toHaveBeenCalledWith("claude-client", "authorization-code");

    await expect(
      provider.exchangeAuthorizationCode(
        { client_id: "claude-client" } as any,
        "authorization-code",
        undefined,
        "https://claude.example.com/oauth/callback",
        new URL("https://quickbooks.example.com/mcp"),
      ),
    ).resolves.toEqual({ access_token: "access-token" });

    await expect(
      provider.exchangeRefreshToken(
        { client_id: "claude-client" } as any,
        "refresh-token",
        ["mcp", "mcp:read"],
        new URL("https://quickbooks.example.com/mcp"),
      ),
    ).resolves.toEqual({ access_token: "refreshed-access-token" });

    await expect(provider.verifyAccessToken("access-token")).resolves.toEqual({
      token: "verified-token",
    });

    await provider.revokeToken(
      { client_id: "claude-client" } as any,
      { token: "access-token" } as any,
    );

    expect(connectorAuthStoreMock.revokeOAuthToken).toHaveBeenCalledWith(
      "access-token",
    );
  });

  it("returns 400 when the QuickBooks callback is missing required parameters", async () => {
    const response = createJsonResponse();

    await handleQuickBooksOAuthCallback(
      {
        query: {
          state: ["bad-state"],
        },
      } as any,
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      error: "Missing QuickBooks OAuth callback parameters",
    });
  });

  it("returns 400 when the QuickBooks callback state is invalid", async () => {
    connectorAuthStoreMock.consumePendingAuthorization.mockResolvedValueOnce(null);
    const response = createJsonResponse();

    await handleQuickBooksOAuthCallback(
      {
        query: {
          state: "quickbooks-state",
          code: "quickbooks-code",
          realmId: "realm-123",
        },
      } as any,
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      error: "Invalid or expired QuickBooks OAuth state",
    });
  });

  it("returns 502 when QuickBooks does not provide a refresh token and realm ID", async () => {
    exchangeQuickBooksCallbackMock.mockResolvedValueOnce({});
    const response = createJsonResponse();

    await handleQuickBooksOAuthCallback(
      {
        query: {
          state: "quickbooks-state",
          code: "quickbooks-code",
          realmId: "realm-123",
        },
      } as any,
      response,
    );

    expect(response.status).toHaveBeenCalledWith(502);
    expect(response.json).toHaveBeenCalledWith({
      error: "QuickBooks token response missing refresh token or realm ID",
    });
  });

  it("logs the callback stage when the QuickBooks token exchange fails", async () => {
    exchangeQuickBooksCallbackMock.mockRejectedValueOnce(
      new Error("token exchange failed"),
    );

    await expect(
      handleQuickBooksOAuthCallback(
        {
          query: {
            state: "quickbooks-state",
            code: "quickbooks-code",
            realmId: "realm-123",
          },
        } as any,
        createJsonResponse(),
      ),
    ).rejects.toThrow("token exchange failed");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "QuickBooks callback failed",
      expect.objectContaining({
        stage: "exchange_quickbooks_callback",
        principalId: "connector:test-principal",
        clientId: "claude-client",
        realmId: "realm-123",
        requestedScope: "mcp mcp:read",
        connectionId: undefined,
        environment: "sandbox",
        errorName: "Error",
        errorMessage: "token exchange failed",
      }),
    );
  });

  it("redirects back to Claude after a successful QuickBooks callback", async () => {
    process.env.QUICKBOOKS_ENVIRONMENT = "production";
    const response = createJsonResponse();

    await handleQuickBooksOAuthCallback(
      {
        query: {
          state: "quickbooks-state",
          code: "quickbooks-code",
          realmId: "realm-123",
          extra: ["first", "second"],
        },
      } as any,
      response,
    );

    expect(exchangeQuickBooksCallbackMock).toHaveBeenCalledWith(
      "https://quickbooks.example.com/oauth/quickbooks/callback?state=quickbooks-state&code=quickbooks-code&realmId=realm-123&extra=first&extra=second",
      {
        redirectUri: "https://quickbooks.example.com/oauth/quickbooks/callback",
      },
    );
    expect(connectorAuthStoreMock.storeQuickBooksConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: "production",
      }),
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      "Set-Cookie",
      expect.stringContaining("mcp_connector_principal="),
    );
    expect(response.redirect).toHaveBeenCalledWith(
      302,
      "https://claude.example.com/oauth/callback?code=authorization-code&state=claude-state",
    );
  });

  it("returns 500 when an authorization code is not created", async () => {
    connectorAuthStoreMock.consumePendingAuthorization.mockResolvedValueOnce({
      principalId: "connector:test-principal",
      clientId: "claude-client",
      redirectUri: "https://claude.example.com/oauth/callback",
      codeChallenge: "pkce-challenge",
      requestedScope: "mcp mcp:read",
    });
    connectorAuthStoreMock.createAuthorizationCode.mockResolvedValueOnce("");
    const response = createJsonResponse();

    await handleQuickBooksOAuthCallback(
      {
        query: {
          state: "quickbooks-state",
          code: "quickbooks-code",
          realmId: "realm-123",
        },
      } as any,
      response,
    );

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      error: "Failed to complete connector authorization",
    });
  });

  it("falls back to the default MCP scope and omits state when callback auth data is sparse", async () => {
    consumePendingAuthorizationMock.mockResolvedValueOnce({
      principalId: "connector:test-principal",
      clientId: "claude-client",
      redirectUri: "https://claude.example.com/oauth/callback",
      codeChallenge: "pkce-challenge",
      requestedScope: "",
    });
    const response = createJsonResponse();

    await handleQuickBooksOAuthCallback(
      {
        query: {
          state: "quickbooks-state",
          code: "quickbooks-code",
          realmId: "realm-123",
        },
      } as any,
      response,
    );

    expect(createAuthorizationCodeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "mcp mcp:read",
      }),
    );
    expect(response.redirect).toHaveBeenCalledWith(
      302,
      "https://claude.example.com/oauth/callback?code=authorization-code",
    );
  });

  it("preserves write scope through the callback authorization code exchange", async () => {
    consumePendingAuthorizationMock.mockResolvedValueOnce({
      principalId: "connector:test-principal",
      clientId: "claude-client",
      redirectUri: "https://claude.example.com/oauth/callback",
      claudeState: "claude-state",
      codeChallenge: "pkce-challenge",
      requestedScope: "mcp mcp:read mcp:write",
      resource: "https://quickbooks.example.com/mcp",
    });
    const response = createJsonResponse();

    await handleQuickBooksOAuthCallback(
      {
        query: {
          state: "quickbooks-state",
          code: "quickbooks-code",
          realmId: "realm-123",
        },
      } as any,
      response,
    );

    expect(createAuthorizationCodeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "mcp mcp:read mcp:write",
      }),
    );
  });

  it("cleans up when storing the QuickBooks connection fails before a connection exists", async () => {
    connectorAuthStoreMock.storeQuickBooksConnection.mockRejectedValueOnce(
      new Error("store failed"),
    );

    await expect(
      handleQuickBooksOAuthCallback(
        {
          query: {
            state: "quickbooks-state",
            code: "quickbooks-code",
            realmId: "realm-123",
          },
        } as any,
        createJsonResponse(),
      ),
    ).rejects.toThrow("store failed");

    expect(invalidateConnectorTokenCacheMock).not.toHaveBeenCalled();
    expect(connectorAuthStoreMock.updateConnectionStatus).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "QuickBooks callback failed",
      expect.objectContaining({
        stage: "store_quickbooks_connection",
        principalId: "connector:test-principal",
        clientId: "claude-client",
        realmId: "realm-123",
        requestedScope: "mcp mcp:read",
        connectionId: undefined,
        errorName: "Error",
        errorMessage: "store failed",
      }),
    );
  });

  it("cleans up and records the error message when authorization code creation throws an Error", async () => {
    storeQuickBooksConnectionMock.mockResolvedValueOnce({
      id: "connection-123",
      principalId: "connector:test-principal",
      realmId: "stored-realm-123",
      environment: "sandbox",
      refreshTokenSecretId: "secret-123",
      scopes: ["com.intuit.quickbooks.accounting"],
      status: "active",
      companyName: "Acme Corp",
    });
    connectorAuthStoreMock.createAuthorizationCode.mockRejectedValueOnce(
      new Error("authorization code failed"),
    );

    await expect(
      handleQuickBooksOAuthCallback(
        {
          query: {
            state: "quickbooks-state",
            code: "quickbooks-code",
            realmId: "realm-123",
          },
        } as any,
        createJsonResponse(),
      ),
    ).rejects.toThrow("authorization code failed");

    expect(invalidateConnectorTokenCacheMock).toHaveBeenCalledWith(
      "connection-123",
    );
    expect(connectorAuthStoreMock.updateConnectionStatus).toHaveBeenCalledWith({
      connectionId: "connection-123",
      status: "disconnected",
    });
    expect(connectorAuthStoreMock.revokeTokensForConnection).toHaveBeenCalledWith(
      "connection-123",
    );
    expect(connectorAuthStoreMock.writeAuditEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outcome: "failure",
        errorCode: "authorization code failed",
        metadata: { failedStage: "create_authorization_code" },
      }),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "QuickBooks callback failed",
      expect.objectContaining({
        stage: "create_authorization_code",
        principalId: "connector:test-principal",
        clientId: "claude-client",
        realmId: "stored-realm-123",
        requestedScope: "mcp mcp:read",
        connectionId: "connection-123",
        errorName: "Error",
        errorMessage: "authorization code failed",
      }),
    );
  });

  it("falls back to callback_failed when authorization code creation throws a non-Error", async () => {
    storeQuickBooksConnectionMock.mockResolvedValueOnce({
      id: "connection-123",
      principalId: "connector:test-principal",
      realmId: "stored-realm-123",
      environment: "sandbox",
      refreshTokenSecretId: "secret-123",
      scopes: ["com.intuit.quickbooks.accounting"],
      status: "active",
      companyName: "Acme Corp",
    });
    connectorAuthStoreMock.createAuthorizationCode.mockRejectedValueOnce(
      "authorization code failed",
    );

    await expect(
      handleQuickBooksOAuthCallback(
        {
          query: {
            state: "quickbooks-state",
            code: "quickbooks-code",
            realmId: "realm-123",
          },
        } as any,
        createJsonResponse(),
      ),
    ).rejects.toBe("authorization code failed");

    expect(connectorAuthStoreMock.writeAuditEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outcome: "failure",
        errorCode: "callback_failed",
        metadata: { failedStage: "create_authorization_code" },
      }),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "QuickBooks callback failed",
      expect.objectContaining({
        stage: "create_authorization_code",
        principalId: "connector:test-principal",
        clientId: "claude-client",
        realmId: "stored-realm-123",
        requestedScope: "mcp mcp:read",
        connectionId: "connection-123",
        errorName: "UnknownError",
        errorMessage: "authorization code failed",
      }),
    );
  });

  it("logs cleanup stage failures after a partial callback success", async () => {
    storeQuickBooksConnectionMock.mockResolvedValueOnce({
      id: "connection-123",
      principalId: "connector:test-principal",
      realmId: "stored-realm-123",
      environment: "sandbox",
      refreshTokenSecretId: "secret-123",
      scopes: ["com.intuit.quickbooks.accounting"],
      status: "active",
      companyName: "Acme Corp",
    });
    createAuthorizationCodeMock.mockRejectedValueOnce(
      new Error("authorization code failed"),
    );
    updateConnectionStatusMock.mockRejectedValueOnce(new Error("cleanup failed"));

    await expect(
      handleQuickBooksOAuthCallback(
        {
          query: {
            state: "quickbooks-state",
            code: "quickbooks-code",
            realmId: "realm-123",
          },
        } as any,
        createJsonResponse(),
      ),
    ).rejects.toThrow("cleanup failed");

    expect(consoleErrorSpy).toHaveBeenNthCalledWith(
      1,
      "QuickBooks callback failed",
      expect.objectContaining({
        stage: "create_authorization_code",
        connectionId: "connection-123",
        errorMessage: "authorization code failed",
      }),
    );
    expect(consoleErrorSpy).toHaveBeenNthCalledWith(
      2,
      "QuickBooks callback cleanup failed",
      expect.objectContaining({
        stage: "cleanup_update_connection_status",
        failedStage: "create_authorization_code",
        connectionId: "connection-123",
        realmId: "stored-realm-123",
        errorName: "Error",
        errorMessage: "cleanup failed",
      }),
    );
  });

  it("logs the success audit stage and still cleans up when success audit writing fails", async () => {
    writeAuditEventMock
      .mockRejectedValueOnce(new Error("success audit failed"))
      .mockResolvedValueOnce(undefined);

    await expect(
      handleQuickBooksOAuthCallback(
        {
          query: {
            state: "quickbooks-state",
            code: "quickbooks-code",
            realmId: "realm-123",
          },
        } as any,
        createJsonResponse(),
      ),
    ).rejects.toThrow("success audit failed");

    expect(invalidateConnectorTokenCacheMock).toHaveBeenCalledWith(
      "connection-123",
    );
    expect(writeAuditEventMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: { failedStage: "write_success_audit_event" },
      }),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "QuickBooks callback failed",
      expect.objectContaining({
        stage: "write_success_audit_event",
        realmId: "realm-123",
        connectionId: "connection-123",
        errorMessage: "success audit failed",
      }),
    );
  });

  it("uses the unknown-principal fallback when cleanup audit logging runs without a principal", async () => {
    consumePendingAuthorizationMock.mockResolvedValueOnce({
      clientId: "claude-client",
      redirectUri: "https://claude.example.com/oauth/callback",
      codeChallenge: "pkce-challenge",
      requestedScope: "mcp mcp:read",
    });
    createAuthorizationCodeMock.mockRejectedValueOnce(
      new Error("authorization code failed"),
    );

    await expect(
      handleQuickBooksOAuthCallback(
        {
          query: {
            state: "quickbooks-state",
            code: "quickbooks-code",
            realmId: "realm-123",
          },
        } as any,
        createJsonResponse(),
      ),
    ).rejects.toThrow("authorization code failed");

    expect(writeAuditEventMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        principalId: "unknown-principal",
        metadata: { failedStage: "create_authorization_code" },
      }),
    );
  });

  it("throws when status is requested without an authenticated principal", async () => {
    await expect(
      handleQuickBooksStatus({ auth: { extra: {} } } as any, createJsonResponse()),
    ).rejects.toThrow("No authenticated connector principal on request");
  });

  it("returns 409 when status lookup finds multiple active connections", async () => {
    connectorAuthStoreMock.getActiveQuickBooksConnection.mockRejectedValueOnce(
      new MultipleActiveQuickBooksConnectionsError("connector:test-principal"),
    );
    const response = createJsonResponse();

    await handleQuickBooksStatus(
      { auth: { extra: { principalId: "connector:test-principal" } } } as any,
      response,
    );

    expect(response.status).toHaveBeenCalledWith(409);
  });

  it("rethrows unexpected status lookup errors", async () => {
    connectorAuthStoreMock.getActiveQuickBooksConnection.mockRejectedValueOnce(
      new Error("status failed"),
    );

    await expect(
      handleQuickBooksStatus(
        { auth: { extra: { principalId: "connector:test-principal" } } } as any,
        createJsonResponse(),
      ),
    ).rejects.toThrow("status failed");
  });

  it("returns connection details when status lookup succeeds", async () => {
    connectorAuthStoreMock.getActiveQuickBooksConnection.mockResolvedValueOnce({
      id: "connection-123",
      principalId: "connector:test-principal",
      realmId: "realm-123",
      environment: "sandbox",
      refreshTokenSecretId: "secret-123",
      scopes: ["com.intuit.quickbooks.accounting"],
      status: "active",
      companyName: "Acme Corp",
    });
    const response = createJsonResponse();

    await handleQuickBooksStatus(
      { auth: { extra: { principalId: "connector:test-principal" } } } as any,
      response,
    );

    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({
      connected: true,
      principalId: "connector:test-principal",
      connection: {
        id: "connection-123",
        realmId: "realm-123",
        environment: "sandbox",
        status: "active",
        companyName: "Acme Corp",
      },
    });
  });

  it("returns disconnected status when there is no active QuickBooks connection", async () => {
    const response = createJsonResponse();

    await handleQuickBooksStatus(
      { auth: { extra: { principalId: "connector:test-principal" } } } as any,
      response,
    );

    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({
      connected: false,
      principalId: "connector:test-principal",
      connection: null,
    });
  });

  it("returns 409 when disconnect sees multiple active connections", async () => {
    connectorAuthStoreMock.getActiveQuickBooksConnection.mockRejectedValueOnce(
      new MultipleActiveQuickBooksConnectionsError("connector:test-principal"),
    );
    const response = createJsonResponse();

    await handleQuickBooksDisconnect(
      { auth: { extra: { principalId: "connector:test-principal" } } } as any,
      response,
    );

    expect(response.status).toHaveBeenCalledWith(409);
  });

  it("rethrows unexpected disconnect lookup errors", async () => {
    connectorAuthStoreMock.getActiveQuickBooksConnection.mockRejectedValueOnce(
      new Error("disconnect failed"),
    );

    await expect(
      handleQuickBooksDisconnect(
        { auth: { extra: { principalId: "connector:test-principal" } } } as any,
        createJsonResponse(),
      ),
    ).rejects.toThrow("disconnect failed");
  });

  it("returns 404 when disconnect is called without an active QuickBooks connection", async () => {
    const response = createJsonResponse();

    await handleQuickBooksDisconnect(
      { auth: { extra: { principalId: "connector:test-principal" } } } as any,
      response,
    );

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({
      error: "No active QuickBooks connection for current principal",
    });
  });

  it("disconnects an active QuickBooks connection and records the audit event", async () => {
    connectorAuthStoreMock.getActiveQuickBooksConnection.mockResolvedValueOnce({
      id: "connection-123",
      principalId: "connector:test-principal",
      realmId: "realm-123",
      environment: "sandbox",
      refreshTokenSecretId: "secret-123",
      scopes: ["com.intuit.quickbooks.accounting"],
      status: "active",
      companyName: "Acme Corp",
    });
    const response = createJsonResponse();

    await handleQuickBooksDisconnect(
      { auth: { extra: { principalId: "connector:test-principal" } } } as any,
      response,
    );

    expect(connectorAuthStoreMock.updateConnectionStatus).toHaveBeenCalledWith({
      connectionId: "connection-123",
      status: "disconnected",
    });
    expect(invalidateConnectorTokenCacheMock).toHaveBeenCalledWith(
      "connection-123",
    );
    expect(connectorAuthStoreMock.revokeTokensForConnection).toHaveBeenCalledWith(
      "connection-123",
    );
    expect(connectorAuthStoreMock.writeAuditEvent).toHaveBeenLastCalledWith({
      principalId: "connector:test-principal",
      connectionId: "connection-123",
      realmId: "realm-123",
      toolName: "oauth_disconnect",
      actionType: "write",
      decision: "allowed",
      outcome: "success",
    });
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({ disconnected: true });
  });

  it("redirects QuickBooks start requests into the local authorize endpoint", async () => {
    const response = createJsonResponse();

    await handleQuickBooksStart(
      {
        query: {
          foo: "bar",
          extra: ["one", 2, "two"],
          ignored: 7,
        },
      } as any,
      response,
    );

    expect(response.redirect).toHaveBeenCalledWith(
      302,
      "https://quickbooks.example.com/authorize?foo=bar&extra=one&extra=two",
    );
  });

  it("throws when QuickBooks start is called without a public base URL", async () => {
    delete process.env.MCP_PUBLIC_BASE_URL;

    await expect(
      handleQuickBooksStart({ query: {} } as any, createJsonResponse()),
    ).rejects.toThrow("MCP_PUBLIC_BASE_URL is required for connector auth mode");
  });
});
