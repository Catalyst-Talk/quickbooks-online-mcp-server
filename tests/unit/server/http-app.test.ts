import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it, jest } from "@jest/globals";

const originalEnv = {
  MCP_AUTH_MODE: process.env.MCP_AUTH_MODE,
  MCP_PUBLIC_BASE_URL: process.env.MCP_PUBLIC_BASE_URL,
  MCP_CONNECTOR_COOKIE_SECRET: process.env.MCP_CONNECTOR_COOKIE_SECRET,
};

process.env.MCP_AUTH_MODE = "connector";
process.env.MCP_PUBLIC_BASE_URL = "https://quickbooks-mcp.catalyst.talk";
process.env.MCP_CONNECTOR_COOKIE_SECRET = "test-cookie-secret";

jest.unstable_mockModule("../../../src/index.js", () => ({
  registerAllTools: jest.fn(),
}));

const { getHttpApp } = await import("../../../src/server/http-app");

async function withHttpApp<T>(
  callback: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer(getHttpApp());

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    return await callback(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

afterAll(() => {
  if (originalEnv.MCP_AUTH_MODE === undefined) {
    delete process.env.MCP_AUTH_MODE;
  } else {
    process.env.MCP_AUTH_MODE = originalEnv.MCP_AUTH_MODE;
  }

  if (originalEnv.MCP_PUBLIC_BASE_URL === undefined) {
    delete process.env.MCP_PUBLIC_BASE_URL;
  } else {
    process.env.MCP_PUBLIC_BASE_URL = originalEnv.MCP_PUBLIC_BASE_URL;
  }

  if (originalEnv.MCP_CONNECTOR_COOKIE_SECRET === undefined) {
    delete process.env.MCP_CONNECTOR_COOKIE_SECRET;
  } else {
    process.env.MCP_CONNECTOR_COOKIE_SECRET = originalEnv.MCP_CONNECTOR_COOKIE_SECRET;
  }
});

describe("HTTP app MCP discovery", () => {
  it("serves MCP discovery metadata on the public and Vercel rewrite paths", async () => {
    await withHttpApp(async (baseUrl) => {
      const publicResponse = await fetch(`${baseUrl}/.well-known/mcp.json`);
      expect(publicResponse.status).toBe(200);
      await expect(publicResponse.json()).resolves.toEqual({
        name: "QuickBooks Online MCP Server",
        description: "Model Context Protocol server for QuickBooks Online integration",
        endpoint: "https://quickbooks-mcp.catalyst.talk/mcp",
      });

      const vercelRouteResponse = await fetch(`${baseUrl}/api/mcp-discovery`);
      expect(vercelRouteResponse.status).toBe(200);
      await expect(vercelRouteResponse.json()).resolves.toEqual({
        name: "QuickBooks Online MCP Server",
        description: "Model Context Protocol server for QuickBooks Online integration",
        endpoint: "https://quickbooks-mcp.catalyst.talk/mcp",
      });
    });
  });

  it("treats the root path as an MCP endpoint alias in connector mode", async () => {
    await withHttpApp(async (baseUrl) => {
      const rootResponse = await fetch(`${baseUrl}/`);
      const mcpResponse = await fetch(`${baseUrl}/mcp`);

      expect(rootResponse.status).toBe(401);
      expect(mcpResponse.status).toBe(401);
      expect(rootResponse.headers.get("www-authenticate")).toBe(
        mcpResponse.headers.get("www-authenticate"),
      );

      await expect(rootResponse.json()).resolves.toEqual({
        error: "invalid_token",
        error_description: "Missing Authorization header",
      });
    });
  });
});
