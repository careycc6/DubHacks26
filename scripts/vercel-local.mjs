// Run the Vercel bundle locally in serverless mode (VERCEL=1): `npm run build:vercel && node scripts/vercel-local.mjs`.
// Each request goes through the same handler Vercel calls, so reload-per-request, polling and webhooks can be tested.
process.env.VERCEL = "1";
const { createServer } = await import("node:http");
const { default: handler } = await import("../api/index.mjs");
const port = Number(process.env.PORT_VERCEL_LOCAL ?? 3101);
createServer((req, res) => handler(req, res)).listen(port, () => console.log(`serverless mode on http://localhost:${port}`));
