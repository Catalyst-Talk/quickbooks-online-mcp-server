import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { authStorage } from "../clients/auth-context.js";
import { connectorAuthStore } from "../storage/connector-auth-store.js";
import { createMcpServer } from "./qbo-mcp-server.js";

type StreamableHttpRequest = IncomingMessage & {
  body?: unknown;
  auth?: AuthInfo;
};
type ConfigureServer = (server: McpServer) => void;

function isConnectorAuthMode(): boolean {
  return process.env.MCP_AUTH_MODE === "connector";
}

function getHeaderValue(header?: string | string[]): string | undefined {
  if (Array.isArray(header)) {
    return header[0];
  }

  return header;
}

function getAllowedOrigins(): Set<string> {
  return new Set(
    (process.env.MCP_ALLOWED_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

function isOriginAllowed(req: StreamableHttpRequest): boolean {
  const origin = getHeaderValue(req.headers.origin);
  if (!origin) {
    return true;
  }

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return false;
  }

  const host =
    getHeaderValue(req.headers["x-forwarded-host"]) ||
    getHeaderValue(req.headers.host);
  const protocol = getHeaderValue(req.headers["x-forwarded-proto"]) || "http";

  if (host) {
    const requestOrigin = `${protocol}://${host}`;
    if (parsedOrigin.origin === requestOrigin) {
      return true;
    }
  }

  return getAllowedOrigins().has(parsedOrigin.origin);
}

function extractBearerToken(
  authorization?: string | string[],
): string | undefined {
  const header = Array.isArray(authorization)
    ? authorization[0]
    : authorization;
  if (!header?.startsWith("Bearer ")) {
    return undefined;
  }

  return header.slice("Bearer ".length).trim() || undefined;
}

function getToolActionType(toolName: string): "read" | "write" {
  return /^(create_|update_|delete_)/.test(toolName) ? "write" : "read";
}

function hasRequiredToolScope(
  tokenScopes: string[] | undefined,
  actionType: "read" | "write",
): boolean {
  const scopes = new Set(tokenScopes ?? []);

  if (actionType === "write") {
    return scopes.has("mcp:write");
  }

  return scopes.has("mcp:read") || scopes.has("mcp:write");
}

function getToolCallName(requestBody: unknown): string | undefined {
  if (
    !requestBody ||
    typeof requestBody !== "object" ||
    Array.isArray(requestBody)
  ) {
    return undefined;
  }

  const method =
    typeof (requestBody as { method?: unknown }).method === "string"
      ? (requestBody as { method: string }).method
      : undefined;
  if (method !== "tools/call") {
    return undefined;
  }

  const params = (requestBody as { params?: unknown }).params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }

  return typeof (params as { name?: unknown }).name === "string"
    ? (params as { name: string }).name
    : undefined;
}

function getJsonRpcId(requestBody: unknown): string | number | null {
  if (
    !requestBody ||
    typeof requestBody !== "object" ||
    Array.isArray(requestBody)
  ) {
    return null;
  }

  const id = (requestBody as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function writeJsonRpcError(
  res: ServerResponse,
  requestId: string | number | null,
  message: string,
): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      error: {
        code: -32001,
        message,
      },
    }),
  );
}

function getToolOutcomeFromResponse(
  responseText: string,
): "success" | "failure" {
  try {
    const parsed = JSON.parse(responseText) as {
      error?: unknown;
      result?: unknown;
    };
    if (parsed.error) {
      return "failure";
    }
    return parsed.result ? "success" : "failure";
  } catch {
    return "success";
  }
}

async function readRequestBody(req: StreamableHttpRequest): Promise<unknown> {
  if (req.body !== undefined) {
    return req.body;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  if (chunks.length === 0) {
    return undefined;
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  if (!rawBody) {
    return undefined;
  }

  return JSON.parse(rawBody);
}

export async function handleStreamableHttpRequest(
  req: StreamableHttpRequest,
  res: ServerResponse,
  configureServer: ConfigureServer,
): Promise<void> {
  if (!isOriginAllowed(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Forbidden origin" }));
    return;
  }

  const accessToken = isConnectorAuthMode()
    ? undefined
    : extractBearerToken(req.headers.authorization);
  const principalId =
    typeof req.auth?.extra?.principalId === "string"
      ? req.auth.extra.principalId
      : undefined;
  const quickBooksConnectionId =
    typeof req.auth?.extra?.quickbooksConnectionId === "string"
      ? req.auth.extra.quickbooksConnectionId
      : undefined;
  const tokenScopes = Array.isArray(req.auth?.scopes)
    ? req.auth.scopes
    : undefined;
  const clientId = req.auth?.clientId;

  if (isConnectorAuthMode() && !principalId) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Connector auth required" }));
    return;
  }

  await authStorage.run(
    {
      accessToken,
      principalId,
      clientId,
      tokenScopes,
      quickBooksConnectionId,
    },
    async () => {
      let toolName: string | undefined;
      let actionType: "read" | "write" | undefined;
      let requestId: string | number | null = null;
      try {
        if (req.method === "GET") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error:
                "This deployment runs Streamable HTTP in stateless JSON mode. Use POST requests to /mcp.",
            }),
          );
          return;
        }

        if (req.method !== "POST" && req.method !== "DELETE") {
          res.writeHead(405, { Allow: "POST, DELETE" });
          res.end();
          return;
        }

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        const server = createMcpServer();
        configureServer(server);
        await server.connect(transport);

        const requestBody =
          req.method === "POST" ? await readRequestBody(req) : undefined;

        if (Array.isArray(requestBody)) {
          writeJsonRpcError(
            res,
            null,
            "Batch JSON-RPC requests are not supported",
          );
          return;
        }

        toolName = getToolCallName(requestBody);
        requestId = getJsonRpcId(requestBody);
        if (toolName && principalId) {
          actionType = getToolActionType(toolName);
          if (!hasRequiredToolScope(tokenScopes, actionType)) {
            await connectorAuthStore.writeAuditEvent({
              requestId:
                typeof requestId === "string" &&
                /^[0-9a-fA-F-]{36}$/.test(requestId)
                  ? requestId
                  : undefined,
              principalId,
              connectionId: quickBooksConnectionId,
              toolName,
              actionType,
              decision: "denied",
              outcome: "failure",
              errorCode: "insufficient_scope",
            });
            writeJsonRpcError(
              res,
              requestId,
              actionType === "write"
                ? `Tool ${toolName} requires mcp:write scope`
                : `Tool ${toolName} requires MCP read scope`,
            );
            return;
          }
        }

        const responseChunks: Buffer[] = [];
        const originalWrite = res.write.bind(res);
        const originalEnd = res.end.bind(res);
        res.write = ((chunk: any, encoding?: any, callback?: any) => {
          if (chunk !== undefined) {
            responseChunks.push(
              Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding),
            );
          }
          return originalWrite(chunk, encoding, callback);
        }) as typeof res.write;
        res.end = ((chunk?: any, encoding?: any, callback?: any) => {
          if (chunk !== undefined) {
            responseChunks.push(
              Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding),
            );
          }
          return originalEnd(chunk, encoding, callback);
        }) as typeof res.end;

        await transport.handleRequest(req, res, requestBody);

        if (toolName && principalId) {
          const responseText = Buffer.concat(responseChunks).toString("utf8");
          await connectorAuthStore.writeAuditEvent({
            requestId:
              typeof requestId === "string" &&
              /^[0-9a-fA-F-]{36}$/.test(requestId)
                ? requestId
                : undefined,
            principalId,
            connectionId: quickBooksConnectionId,
            toolName,
            actionType: getToolActionType(toolName),
            decision: "allowed",
            outcome: getToolOutcomeFromResponse(responseText),
          });
        }
      } catch (error) {
        console.error("Error handling MCP request:", error);

        if (toolName && principalId) {
          await connectorAuthStore.writeAuditEvent({
            requestId:
              typeof requestId === "string" &&
              /^[0-9a-fA-F-]{36}$/.test(requestId)
                ? requestId
                : undefined,
            principalId,
            connectionId: quickBooksConnectionId,
            toolName,
            actionType: actionType ?? getToolActionType(toolName),
            decision: "allowed",
            outcome: "failure",
            errorCode: error instanceof Error ? error.message : "tool_failed",
          });
        }

        if (!res.headersSent) {
          const statusCode = error instanceof SyntaxError ? 400 : 500;
          const message =
            error instanceof SyntaxError
              ? "Invalid JSON request body"
              : "Internal server error";
          res.writeHead(statusCode, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: message }));
        }
      }
    },
  );
}
