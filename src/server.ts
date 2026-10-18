// Laptop / container entry point: one long-running server with the Photon stream open.
// (Vercel uses vercel.ts instead.)
import { app } from "./app.ts";
import { startPhoton } from "./channels/photon.ts";

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Cart Court dashboard: http://localhost:${port}  ·  setup: /setup  ·  family case file: /cart`);
  console.log(process.env.GEMINI_API_KEY ? `[llm] Gemini (${process.env.GEMINI_MODELS || process.env.GEMINI_MODEL || "gemini-3.8-flash + fallbacks"})` : "[llm] no GEMINI_API_KEY: rules-only mode");
});
startPhoton().catch((err) => console.error("[photon] failed to start:", err));
