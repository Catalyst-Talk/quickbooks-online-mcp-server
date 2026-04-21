import type { Request, Response, NextFunction } from "express";
import express from "express";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { registerAllTools } from "../index.js";
import { handleStreamableHttpRequest } from "./streamable-http-handler.js";
import {
  ConnectorOAuthServerProvider,
  handleQuickBooksOAuthCallback,
  handleQuickBooksDisconnect,
  handleQuickBooksStart,
  handleQuickBooksStatus,
} from "./connector-oauth-provider.js";

let app: express.Express | null = null;

function getPublicBaseUrl(): URL {
  const baseUrl = process.env.MCP_PUBLIC_BASE_URL;
  if (!baseUrl) {
    throw new Error("MCP_PUBLIC_BASE_URL is required for connector auth mode");
  }

  return new URL(baseUrl);
}

function isConnectorAuthMode(): boolean {
  return process.env.MCP_AUTH_MODE === "connector";
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res).catch(next);
  };
}

function requireScope(scope: "mcp:read" | "mcp:write") {
  return (req: Request, res: Response, next: NextFunction): void => {
    const scopes = Array.isArray(req.auth?.scopes) ? req.auth.scopes : [];
    const allowed =
      scope === "mcp:read"
        ? scopes.includes("mcp:read") || scopes.includes("mcp:write")
        : scopes.includes("mcp:write");

    if (!allowed) {
      res.status(403).json({ error: `Missing required scope: ${scope}` });
      return;
    }

    next();
  };
}

function createApp(): express.Express {
  const instance = express();

  instance.get(["/health", "/api/health"], (_req, res) => {
    res.status(200).type("text/plain").send("ok");
  });

  if (isConnectorAuthMode()) {
    const provider = new ConnectorOAuthServerProvider();
    const publicBaseUrl = getPublicBaseUrl();
    const resourceServerUrl = new URL("/mcp", publicBaseUrl);
    const authRouter = mcpAuthRouter({
      provider,
      issuerUrl: publicBaseUrl,
      baseUrl: publicBaseUrl,
      resourceServerUrl,
      resourceName: "QuickBooks Online MCP Server",
      scopesSupported: ["mcp", "mcp:read", "mcp:write"],
    });
    const resourceMetadataUrl =
      getOAuthProtectedResourceMetadataUrl(resourceServerUrl);
    const bearerAuth = requireBearerAuth({
      verifier: provider,
      requiredScopes: ["mcp"],
      resourceMetadataUrl,
    });

    instance.use(authRouter);
    instance.use("/api", authRouter);

    instance.get(
      ["/oauth/quickbooks/start", "/api/oauth/quickbooks/start"],
      asyncHandler(handleQuickBooksStart),
    );
    instance.get(
      ["/oauth/quickbooks/callback", "/api/oauth/quickbooks/callback"],
      asyncHandler(handleQuickBooksOAuthCallback),
    );
    instance.get(
      ["/oauth/quickbooks/status", "/api/oauth/quickbooks/status"],
      bearerAuth,
      requireScope("mcp:read"),
      asyncHandler(handleQuickBooksStatus),
    );
    instance.post(
      ["/oauth/quickbooks/disconnect", "/api/oauth/quickbooks/disconnect"],
      bearerAuth,
      requireScope("mcp:write"),
      asyncHandler(handleQuickBooksDisconnect),
    );

    instance.all(["/mcp", "/api/mcp"], bearerAuth, (req, res) => {
      void handleStreamableHttpRequest(req, res, registerAllTools);
    });
  } else {
    instance.all(["/mcp", "/api/mcp"], (req, res) => {
      void handleStreamableHttpRequest(req, res, registerAllTools);
    });
  }

  instance.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      console.error("HTTP app error:", error);
      if (!res.headersSent) {
        const isAuthPath =
          _req.path.startsWith("/authorize") ||
          _req.path.startsWith("/token") ||
          _req.path.startsWith("/register") ||
          _req.path.startsWith("/revoke") ||
          _req.path.startsWith("/oauth/") ||
          _req.path.startsWith("/api/oauth/");
        const message = isAuthPath
          ? "Authentication flow failed"
          : "Internal server error";
        res.status(500).json({ error: message });
      }
    },
  );

  return instance;
}

export function getHttpApp(): express.Express {
  if (!app) {
    app = createApp();
  }

  return app;
}
