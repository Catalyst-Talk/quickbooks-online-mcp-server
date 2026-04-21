import type { IncomingMessage, ServerResponse } from "node:http";
import { getHttpApp } from "../../src/server/http-app.js";

export const config = {
  api: {
    bodyParser: false,
  },
};

export default function handler(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  getHttpApp()(req, res);
}
