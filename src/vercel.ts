// Vercel entry point (bundled to api/index.mjs by `npm run build:vercel`).
// Every request is handled by the same Express app as the laptop server, in serverless mode
// (runtime.ts): state is re-read from MongoDB per request, iMessages arrive as Photon webhooks at
// /api/photon/webhook, and background work is kept alive with waitUntil until it's saved.
import type { IncomingMessage, ServerResponse } from "node:http";
import { app } from "./app.ts";

export default function handler(req: IncomingMessage, res: ServerResponse) {
  return app(req as Parameters<typeof app>[0], res as Parameters<typeof app>[1]);
}
