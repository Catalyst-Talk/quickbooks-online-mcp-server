import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authStorage } from "../clients/auth-context.js";
import { createMcpServer } from "./qbo-mcp-server.js";

type StreamableHttpRequest = IncomingMessage & { body?: unknown };
type ConfigureServer = (server: McpServer) => void;

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

  const accessToken = extractBearerToken(req.headers.authorization);

  await authStorage.run({ accessToken }, async () => {
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
      await transport.handleRequest(req, res, requestBody);
    } catch (error) {
      console.error("Error handling MCP request:", error);

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
  });
}
