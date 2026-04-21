import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

export function RegisterTool<T extends z.ZodType<any, any>>(
  server: McpServer,
  toolDefinition: ToolDefinition<T>,
) {
  server.tool(
    toolDefinition.name,
    toolDefinition.description,
    { params: toolDefinition.schema },
    toolDefinition.handler,
  );
}
