import type { IncomingMessage, ServerResponse } from "node:http";
import { registerAllTools } from "../src/index.js";
import { handleStreamableHttpRequest } from "../src/server/streamable-http-handler.js";

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  await handleStreamableHttpRequest(req, res, registerAllTools);
}
