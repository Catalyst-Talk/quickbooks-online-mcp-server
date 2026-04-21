import dotenv from "dotenv";
import QuickBooks from "node-quickbooks";
import OAuthClient from "intuit-oauth";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import open from "open";
import {
  getAuthContext,
  getCurrentAccessToken,
  getOptionalAccessToken,
} from "./auth-context.js";
import { connectorAuthStore } from "../storage/connector-auth-store.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const client_id = process.env.QUICKBOOKS_CLIENT_ID;
const client_secret = process.env.QUICKBOOKS_CLIENT_SECRET;
const refresh_token = process.env.QUICKBOOKS_REFRESH_TOKEN;
const configuredRealmId = process.env.QUICKBOOKS_REALM_ID;
const environment = process.env.QUICKBOOKS_ENVIRONMENT || "sandbox";
const isSandbox = environment === "sandbox";
// Fix for Issue #5: Use env var with underscore (QUICKBOOKS_REDIRECT_URI)
const redirect_uri =
  process.env.QUICKBOOKS_REDIRECT_URI || "http://localhost:8000/callback";

const hasOAuthClientConfig = Boolean(
  client_id && client_secret && redirect_uri,
);
const hasRefreshTokenConfig = Boolean(refresh_token && configuredRealmId);

type CachedConnectorToken = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
};

const connectorAccessTokenCache = new Map<string, CachedConnectorToken>();
const connectorRefreshInFlight = new Map<
  string,
  Promise<CachedConnectorToken>
>();

export function invalidateConnectorTokenCache(connectionId: string): void {
  connectorAccessTokenCache.delete(connectionId);
  connectorRefreshInFlight.delete(connectionId);
}

interface QuickBooksOAuthTokens {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  realmId?: string;
  x_refresh_token_expires_in?: number;
}

function requireQuickBooksClientConfig(): {
  clientId: string;
  clientSecret: string;
} {
  if (!client_id || !client_secret) {
    throw new Error(
      "QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET must be configured",
    );
  }

  return { clientId: client_id, clientSecret: client_secret };
}

function createOAuthClientInstance(customRedirectUri?: string): OAuthClient {
  const config = requireQuickBooksClientConfig();
  return new OAuthClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    environment,
    redirectUri: customRedirectUri || redirect_uri,
  });
}

function createQuickBooksInstance(input: {
  accessToken: string;
  refreshToken?: string;
  realmId: string;
  environment: string;
}): QuickBooks {
  const config = requireQuickBooksClientConfig();

  return new QuickBooks(
    config.clientId,
    config.clientSecret,
    input.accessToken,
    false,
    input.realmId,
    input.environment === "sandbox",
    false,
    null,
    "2.0",
    input.refreshToken || "",
  );
}

export function buildQuickBooksAuthorizationUrl(input: {
  state: string;
  redirectUri?: string;
}): string {
  const oauthClient = createOAuthClientInstance(input.redirectUri);
  return oauthClient
    .authorizeUri({
      scope: [OAuthClient.scopes.Accounting as string],
      state: input.state,
    })
    .toString();
}

export async function exchangeQuickBooksCallback(
  callbackUrl: string,
  options?: { redirectUri?: string },
): Promise<QuickBooksOAuthTokens> {
  const oauthClient = createOAuthClientInstance(options?.redirectUri);
  const response = await oauthClient.createToken(callbackUrl);
  return response.token as QuickBooksOAuthTokens;
}

export async function refreshQuickBooksAccessToken(input: {
  refreshToken: string;
  redirectUri?: string;
}): Promise<
  Required<Pick<QuickBooksOAuthTokens, "access_token" | "expires_in">> & {
    refresh_token?: string;
  }
> {
  const oauthClient = createOAuthClientInstance(input.redirectUri);
  const response = await oauthClient.refreshUsingToken(input.refreshToken);
  const token = response.token as QuickBooksOAuthTokens;
  if (!token.access_token) {
    throw new Error("QuickBooks refresh response did not include access_token");
  }

  return {
    access_token: token.access_token,
    expires_in: token.expires_in || 3600,
    refresh_token: token.refresh_token,
  };
}

class QuickbooksClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private refreshToken?: string;
  private realmId?: string;
  private readonly environment: string;
  private accessToken?: string;
  private accessTokenExpiry?: Date;
  private quickbooksInstance?: QuickBooks;
  private oauthClient: OAuthClient;
  private isAuthenticating: boolean = false;
  private redirectUri: string;

  constructor(config: {
    clientId: string;
    clientSecret: string;
    refreshToken?: string;
    realmId?: string;
    environment: string;
    redirectUri: string;
  }) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.refreshToken = config.refreshToken;
    this.realmId = config.realmId;
    this.environment = config.environment;
    this.redirectUri = config.redirectUri;
    this.oauthClient = new OAuthClient({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      environment: this.environment,
      redirectUri: this.redirectUri,
    });
  }

  private async startOAuthFlow(): Promise<void> {
    if (this.isAuthenticating) {
      return;
    }

    this.isAuthenticating = true;
    const port = 8000;

    return new Promise((resolve, reject) => {
      // Create temporary server for OAuth callback
      const server = http.createServer(async (req, res) => {
        if (req.url?.startsWith("/callback")) {
          try {
            const response = await this.oauthClient.createToken(req.url);
            const tokens = response.token;

            // Save tokens
            this.refreshToken = tokens.refresh_token;
            this.realmId = tokens.realmId;
            this.saveTokensToEnv();

            // Send success response
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(`
              <html>
                <body style="
                  display: flex;
                  flex-direction: column;
                  justify-content: center;
                  align-items: center;
                  height: 100vh;
                  margin: 0;
                  font-family: Arial, sans-serif;
                  background-color: #f5f5f5;
                ">
                  <h2 style="color: #2E8B57;">✓ Successfully connected to QuickBooks!</h2>
                  <p>You can close this window now.</p>
                </body>
              </html>
            `);

            // Close server after a short delay
            setTimeout(() => {
              server.close();
              this.isAuthenticating = false;
              resolve();
            }, 1000);
          } catch (error) {
            console.error("Error during token creation:", error);
            res.writeHead(500, { "Content-Type": "text/html" });
            res.end(`
              <html>
                <body style="
                  display: flex;
                  flex-direction: column;
                  justify-content: center;
                  align-items: center;
                  height: 100vh;
                  margin: 0;
                  font-family: Arial, sans-serif;
                  background-color: #fff0f0;
                ">
                  <h2 style="color: #d32f2f;">Error connecting to QuickBooks</h2>
                  <p>Please check the console for more details.</p>
                </body>
              </html>
            `);
            this.isAuthenticating = false;
            reject(error);
          }
        }
      });

      // Start server
      server.listen(port, async () => {
        // Generate authorization URL with proper type assertion
        const authUri = this.oauthClient
          .authorizeUri({
            scope: [OAuthClient.scopes.Accounting as string],
            state: "testState",
          })
          .toString();

        // Open browser automatically
        await open(authUri);
      });

      // Handle server errors
      server.on("error", (error) => {
        console.error("Server error:", error);
        this.isAuthenticating = false;
        reject(error);
      });
    });
  }

  private saveTokensToEnv(): void {
    const tokenPath = path.join(__dirname, "..", "..", ".env");
    const envContent = fs.readFileSync(tokenPath, "utf-8");
    const envLines = envContent.split("\n");

    const updateEnvVar = (name: string, value: string) => {
      const index = envLines.findIndex((line) => line.startsWith(`${name}=`));
      if (index !== -1) {
        envLines[index] = `${name}=${value}`;
      } else {
        envLines.push(`${name}=${value}`);
      }
    };

    if (this.refreshToken)
      updateEnvVar("QUICKBOOKS_REFRESH_TOKEN", this.refreshToken);
    if (this.realmId) updateEnvVar("QUICKBOOKS_REALM_ID", this.realmId);

    fs.writeFileSync(tokenPath, envLines.join("\n"));
  }

  async refreshAccessToken() {
    if (!this.refreshToken) {
      await this.startOAuthFlow();

      // Verify we have a refresh token after OAuth flow
      if (!this.refreshToken) {
        throw new Error("Failed to obtain refresh token from OAuth flow");
      }
    }

    try {
      // At this point we know refreshToken is not undefined
      const authResponse = await this.oauthClient.refreshUsingToken(
        this.refreshToken,
      );
      const refreshedToken = authResponse.token as QuickBooksOAuthTokens;

      this.accessToken = refreshedToken.access_token;
      if (refreshedToken.refresh_token) {
        this.refreshToken = refreshedToken.refresh_token;
        this.saveTokensToEnv();
      }

      // Calculate expiry time
      const expiresIn = refreshedToken.expires_in || 3600; // Default to 1 hour
      this.accessTokenExpiry = new Date(Date.now() + expiresIn * 1000);

      return {
        access_token: this.accessToken,
        expires_in: expiresIn,
      };
    } catch (error: any) {
      throw new Error(`Failed to refresh Quickbooks token: ${error.message}`);
    }
  }

  async authenticate() {
    if (!this.refreshToken || !this.realmId) {
      await this.startOAuthFlow();

      // Verify we have both tokens after OAuth flow
      if (!this.refreshToken || !this.realmId) {
        throw new Error("Failed to obtain required tokens from OAuth flow");
      }
    }

    // Check if token exists and is still valid
    const now = new Date();
    if (
      !this.accessToken ||
      !this.accessTokenExpiry ||
      this.accessTokenExpiry <= now
    ) {
      const tokenResponse = await this.refreshAccessToken();
      this.accessToken = tokenResponse.access_token;
    }

    // At this point we know all tokens are available
    this.quickbooksInstance = new QuickBooks(
      this.clientId,
      this.clientSecret,
      this.accessToken!,
      false, // no token secret for OAuth 2.0
      this.realmId!, // Safe to use ! here as we checked above
      this.environment === "sandbox", // use the sandbox?
      false, // debug?
      null, // minor version
      "2.0", // oauth version
      this.refreshToken,
    );

    return this.quickbooksInstance;
  }

  getQuickbooks() {
    if (!this.quickbooksInstance) {
      throw new Error(
        "Quickbooks not authenticated. Call authenticate() first",
      );
    }
    return this.quickbooksInstance;
  }
}

// Env-backed client for local stdio mode and single-tenant HTTP deployments.
const envBackedClient = hasOAuthClientConfig
  ? new QuickbooksClient({
      clientId: client_id!,
      clientSecret: client_secret!,
      refreshToken: refresh_token,
      realmId: configuredRealmId,
      environment: environment,
      redirectUri: redirect_uri,
    })
  : null;

// Legacy export for auth-server.ts local OAuth bootstrap flow.
export const quickbooksClient = envBackedClient as QuickbooksClient;

/**
 * Creates a per-request QuickBooks client using the provided access token.
 * Used in streamable-http mode where the upstream proxy or MCP client
 * injects the token via the Authorization header on each request.
 */
export function createQuickBooksClient(accessToken?: string): QuickBooks {
  const token = accessToken || getCurrentAccessToken();
  if (!configuredRealmId) {
    throw new Error(
      "QUICKBOOKS_REALM_ID must be set when using HTTP bearer-token mode",
    );
  }

  return new QuickBooks(
    client_id || "",
    client_secret || "",
    token, // access token from Authorization header
    false, // no token secret (OAuth 2.0)
    configuredRealmId,
    isSandbox,
    false, // debug
    null, // minor version
    "2.0", // oauth version
    refresh_token || "",
  );
}

async function getConnectorQuickBooksClient(): Promise<QuickBooks> {
  const authContext = getAuthContext();
  const principalId = authContext?.principalId;
  if (!principalId) {
    throw new Error("No authenticated connector principal in request context");
  }

  const connection =
    await connectorAuthStore.getActiveQuickBooksConnection(principalId);
  if (!connection) {
    throw new Error("No active QuickBooks connection for current principal");
  }

  const storedRefreshToken = await connectorAuthStore.getRefreshToken(
    connection.refreshTokenSecretId,
  );

  const cachedToken = connectorAccessTokenCache.get(connection.id);
  if (cachedToken && cachedToken.expiresAt.getTime() - Date.now() > 60_000) {
    await connectorAuthStore.markConnectionUsed(connection.id, false);
    return createQuickBooksInstance({
      accessToken: cachedToken.accessToken,
      refreshToken: cachedToken.refreshToken,
      realmId: connection.realmId,
      environment: connection.environment,
    });
  }

  const shouldMarkNeedsReauth = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    return (
      message.includes("invalid_grant") ||
      message.includes("invalid refresh") ||
      message.includes("invalid token") ||
      message.includes("unauthorized") ||
      message.includes("token expired")
    );
  };

  let refreshPromise = connectorRefreshInFlight.get(connection.id);
  if (!refreshPromise) {
    refreshPromise = (async (): Promise<CachedConnectorToken> => {
      let currentRefreshToken = storedRefreshToken;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const refreshed = await refreshQuickBooksAccessToken({
            refreshToken: currentRefreshToken,
          });
          const rotatedRefreshToken =
            refreshed.refresh_token || currentRefreshToken;

          if (
            refreshed.refresh_token &&
            refreshed.refresh_token !== currentRefreshToken
          ) {
            await connectorAuthStore.rotateQuickBooksRefreshToken({
              connectionId: connection.id,
              principalId: connection.principalId,
              realmId: connection.realmId,
              refreshToken: refreshed.refresh_token,
            });
          }

          const cached: CachedConnectorToken = {
            accessToken: refreshed.access_token,
            refreshToken: rotatedRefreshToken,
            expiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
          };
          connectorAccessTokenCache.set(connection.id, cached);
          await connectorAuthStore.markConnectionUsed(connection.id, true);
          return cached;
        } catch (error) {
          if (attempt === 0) {
            const latestConnection =
              await connectorAuthStore.getActiveQuickBooksConnection(
                connection.principalId,
              );
            if (
              latestConnection &&
              latestConnection.refreshTokenSecretId !==
                connection.refreshTokenSecretId
            ) {
              currentRefreshToken = await connectorAuthStore.getRefreshToken(
                latestConnection.refreshTokenSecretId,
              );
              continue;
            }
          }

          if (shouldMarkNeedsReauth(error)) {
            invalidateConnectorTokenCache(connection.id);
            await connectorAuthStore.updateConnectionStatus({
              connectionId: connection.id,
              status: "needs_reauth",
            });
            await connectorAuthStore.writeAuditEvent({
              principalId: connection.principalId,
              connectionId: connection.id,
              realmId: connection.realmId,
              toolName: "quickbooks_token_refresh",
              actionType: "write",
              decision: "allowed",
              outcome: "failure",
              errorCode: "needs_reauth",
            });
          }
          throw error;
        }
      }

      throw new Error("Failed to refresh QuickBooks access token");
    })();
    connectorRefreshInFlight.set(connection.id, refreshPromise);
  }

  let refreshedToken: CachedConnectorToken;
  try {
    refreshedToken = await refreshPromise;
  } finally {
    connectorRefreshInFlight.delete(connection.id);
  }

  return createQuickBooksInstance({
    accessToken: refreshedToken.accessToken,
    refreshToken: refreshedToken.refreshToken,
    realmId: connection.realmId,
    environment: connection.environment,
  });
}

/**
 * Gets a QuickBooks instance for the current request context.
 * - stdio mode: authenticates using the singleton client (refreshes token if needed)
 * - streamable-http mode: creates a per-request client with the injected access token
 */
export async function getQuickbooks(): Promise<QuickBooks> {
  const authContext = getAuthContext();
  if (process.env.MCP_AUTH_MODE === "connector" && !authContext?.principalId) {
    throw new Error(
      "Connector mode requires an authenticated principal-bound MCP request",
    );
  }

  if (authContext?.principalId) {
    return getConnectorQuickBooksClient();
  }

  const accessToken = getOptionalAccessToken();
  if (accessToken) {
    return createQuickBooksClient(accessToken);
  }

  if (!envBackedClient) {
    throw new Error(
      "QuickBooks client credentials are missing from the environment",
    );
  }

  if (
    process.env.MCP_TRANSPORT === "streamable-http" &&
    !hasRefreshTokenConfig
  ) {
    throw new Error(
      "HTTP fallback mode requires QUICKBOOKS_REFRESH_TOKEN and QUICKBOOKS_REALM_ID in the environment",
    );
  }

  await envBackedClient.authenticate();
  return envBackedClient.getQuickbooks();
}
