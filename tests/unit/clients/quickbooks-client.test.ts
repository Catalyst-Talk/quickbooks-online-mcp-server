import { afterAll, beforeEach, describe, expect, it, jest } from "@jest/globals";

process.env.QUICKBOOKS_CLIENT_ID = "quickbooks-client-id";
process.env.QUICKBOOKS_CLIENT_SECRET = "quickbooks-client-secret";
process.env.QUICKBOOKS_ENVIRONMENT = "sandbox";

const quickBooksConstructorMock = jest.fn<
  (..._args: unknown[]) => { accessToken: unknown; realmId: unknown }
>();
const refreshUsingTokenMock = jest.fn<
  (_refreshToken: string) => Promise<{ token: Record<string, unknown> }>
>();
const getQuickBooksConnectionByIdMock = jest.fn<
  (_connectionId: string) => Promise<Record<string, unknown> | null>
>();
const getActiveQuickBooksConnectionMock = jest.fn<
  (_principalId: string) => Promise<Record<string, unknown> | null>
>();
const getRefreshTokenMock = jest.fn<(_secretId: string) => Promise<string>>();
const markConnectionUsedMock = jest.fn<
  (_connectionId: string, _didRefreshToken: boolean) => Promise<void>
>();
const rotateQuickBooksRefreshTokenMock = jest.fn<
  (_input: Record<string, unknown>) => Promise<void>
>();
const updateConnectionStatusMock = jest.fn<
  (_input: Record<string, unknown>) => Promise<void>
>();
const writeAuditEventMock = jest.fn<
  (_input: Record<string, unknown>) => Promise<void>
>();

jest.unstable_mockModule("node-quickbooks", () => ({
  default: quickBooksConstructorMock,
}));

jest.unstable_mockModule("intuit-oauth", () => ({
  default: class OAuthClientMock {
    static scopes: Record<string, string> = {
      Accounting: "com.intuit.quickbooks.accounting",
    };

    refreshUsingToken(refreshToken: string) {
      return refreshUsingTokenMock(refreshToken);
    }
  },
}));

jest.unstable_mockModule("../../../src/storage/connector-auth-store", () => ({
  connectorAuthStore: {
    getQuickBooksConnectionById: getQuickBooksConnectionByIdMock,
    getActiveQuickBooksConnection: getActiveQuickBooksConnectionMock,
    getRefreshToken: getRefreshTokenMock,
    markConnectionUsed: markConnectionUsedMock,
    rotateQuickBooksRefreshToken: rotateQuickBooksRefreshTokenMock,
    updateConnectionStatus: updateConnectionStatusMock,
    writeAuditEvent: writeAuditEventMock,
  },
}));

const { authStorage } = await import("../../../src/clients/auth-context");
const { getQuickbooks, invalidateConnectorTokenCache } = await import(
  "../../../src/clients/quickbooks-client"
);

describe("quickbooks-client connector mode", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.MCP_QUICKBOOKS_CONNECTION_MODE;
    delete process.env.MCP_QUICKBOOKS_SHARED_CONNECTION_PRINCIPAL_ID;
    delete process.env.MCP_QUICKBOOKS_SHARED_CONNECTION_ORG_ID;
    process.env.MCP_AUTH_MODE = "connector";
    invalidateConnectorTokenCache("shared-connection-123");
    invalidateConnectorTokenCache("member-connection-123");

    getQuickBooksConnectionByIdMock.mockResolvedValue({
      id: "shared-connection-123",
      principalId: "connector:company-install",
      realmId: "realm-123",
      environment: "sandbox",
      refreshTokenSecretId: "secret-123",
      scopes: ["com.intuit.quickbooks.accounting"],
      status: "active",
      companyName: "Acme Corp",
    });
    getActiveQuickBooksConnectionMock.mockResolvedValue(null);
    getRefreshTokenMock.mockResolvedValue("stored-refresh-token");
    refreshUsingTokenMock.mockResolvedValue({
      token: {
        access_token: "quickbooks-access-token",
        refresh_token: "rotated-refresh-token",
        expires_in: 3600,
      },
    });
    markConnectionUsedMock.mockResolvedValue(undefined);
    rotateQuickBooksRefreshTokenMock.mockResolvedValue(undefined);
    updateConnectionStatusMock.mockResolvedValue(undefined);
    writeAuditEventMock.mockResolvedValue(undefined);
    quickBooksConstructorMock.mockImplementation((...args: unknown[]) => ({
      accessToken: args[2],
      realmId: args[4],
    }));
  });

  afterAll(() => {
    delete process.env.MCP_AUTH_MODE;
  });

  it("uses the bound QuickBooks connection ID for shared connector tokens", async () => {
    const quickbooks = await authStorage.run(
      {
        principalId: "connector:member-principal",
        quickBooksConnectionId: "shared-connection-123",
      },
      () => getQuickbooks(),
    );

    expect(quickbooks).toEqual({
      accessToken: "quickbooks-access-token",
      realmId: "realm-123",
    });
    expect(getQuickBooksConnectionByIdMock).toHaveBeenCalledWith(
      "shared-connection-123",
    );
    expect(getActiveQuickBooksConnectionMock).not.toHaveBeenCalled();
    expect(getRefreshTokenMock).toHaveBeenCalledWith("secret-123");
    expect(refreshUsingTokenMock).toHaveBeenCalledWith("stored-refresh-token");
    expect(rotateQuickBooksRefreshTokenMock).toHaveBeenCalledWith({
      connectionId: "shared-connection-123",
      principalId: "connector:company-install",
      realmId: "realm-123",
      refreshToken: "rotated-refresh-token",
    });
    expect(markConnectionUsedMock).toHaveBeenCalledWith(
      "shared-connection-123",
      true,
    );
    expect(quickBooksConstructorMock).toHaveBeenCalledWith(
      "quickbooks-client-id",
      "quickbooks-client-secret",
      "quickbooks-access-token",
      false,
      "realm-123",
      true,
      false,
      null,
      "2.0",
      "rotated-refresh-token",
    );
  });
});
