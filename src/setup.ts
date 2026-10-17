// /setup: paste keys, check what's connected, and have the court text your phone.
// Only reachable from this computer: never through a tunnel or public URL.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { Router, type NextFunction, type Request, type Response } from "express";
import { photonStatus, sayHello, startPhoton } from "./channels/photon.ts";

const envFile = fileURLToPath(new URL("../.env", import.meta.url));
const exampleFile = fileURLToPath(new URL("../.env.example", import.meta.url));

const EDITABLE = ["GEMINI_API_KEY", "PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET", "PUBLIC_URL", "COURT_NUMBER"] as const;
type Key = (typeof EDITABLE)[number];

function writeEnv(updates: Partial<Record<Key, string>>) {
  const base = existsSync(envFile) ? readFileSync(envFile, "utf8") : readFileSync(exampleFile, "utf8");
  const lines = base.split(/\r?\n/);
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined) continue;
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
    process.env[k] = v;
  }
  writeFileSync(envFile, lines.join("\n"));
}

/** Local-only: loopback address, a localhost Host header, and no proxy/tunnel forwarding headers. */
function localOnly(req: Request, res: Response, next: NextFunction) {
  const ip = req.socket.remoteAddress ?? "";
  const loopback = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  const host = (req.headers.host ?? "").split(":")[0];
  const forwarded = req.headers["x-forwarded-for"] || req.headers["cf-connecting-ip"] || req.headers["forwarded"];
  if (loopback && (host === "localhost" || host === "127.0.0.1") && !forwarded) return next();
  res.status(403).send("Setup is only available on the computer running Cart Court (http://localhost:3000/setup).");
}

const mask = (v?: string) => (v ? `••••${v.slice(-4)}` : "");

export const setupRouter = Router();
setupRouter.use(["/setup", "/setup.html", "/api/setup"], localOnly);

setupRouter.get("/api/setup", (_req, res) => {
  res.json({
    gemini: { configured: !!process.env.GEMINI_API_KEY, hint: mask(process.env.GEMINI_API_KEY) },
    photon: { configured: !!(process.env.PHOTON_PROJECT_ID && process.env.PHOTON_PROJECT_SECRET), ...photonStatus, projectHint: mask(process.env.PHOTON_PROJECT_ID) },
    publicUrl: process.env.PUBLIC_URL ?? "",
    courtNumber: process.env.COURT_NUMBER ?? "",
  });
});

setupRouter.post("/api/setup", async (req, res) => {
  const body = req.body as Partial<Record<Key, string>>;
  const updates: Partial<Record<Key, string>> = {};
  for (const k of EDITABLE) {
    const v = typeof body[k] === "string" ? body[k]!.trim() : undefined;
    if (v) updates[k] = k === "PUBLIC_URL" ? v.replace(/\/+$/, "") : v;
  }
  writeEnv(updates);
  if (updates.PHOTON_PROJECT_ID || updates.PHOTON_PROJECT_SECRET) {
    startPhoton().catch((err) => console.error("[photon] restart failed:", err));
    await new Promise((r) => setTimeout(r, 2500)); // let it report connected / error
  }
  res.json({ ok: true, saved: Object.keys(updates) });
});

setupRouter.post("/api/setup/test-gemini", async (_req, res) => {
  if (!process.env.GEMINI_API_KEY) return res.json({ ok: false, error: "No Gemini key saved yet." });
  const models = (process.env.GEMINI_MODELS || "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash").split(",");
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  let lastError = "";
  for (const model of models.map((m) => m.trim())) {
    try {
      const r = await ai.models.generateContent({ model, contents: "Reply with exactly: Order in the court.", config: { abortSignal: AbortSignal.timeout(15_000) } });
      return res.json({ ok: true, model, reply: r.text?.trim() });
    } catch (err) {
      lastError = String((err as Error).message ?? err);
      if (/402|prepayment/i.test(lastError) || !/429|RESOURCE_EXHAUSTED|abort|timed? ?out/i.test(lastError)) break; // key/billing problems hit every model
    }
  }
  res.json({ ok: false, error: /402|prepayment/i.test(lastError) ? "This key's project is on prepaid billing with no credits left. Open ai.studio/projects, pick this key's project, and add credits or apply your promo credits there. (Until then the court uses rules mode.)" : /API key not valid|API_KEY_INVALID/i.test(lastError) ? "That key isn't valid. Copy it again from aistudio.google.com/apikey." : /429|RESOURCE_EXHAUSTED/.test(lastError) ? "The key works, but today's free quota is used up on every model." : lastError.slice(0, 200) });
});

setupRouter.post("/api/setup/hello", async (req, res) => {
  const phone = String(req.body?.phone ?? "").trim();
  if (!/^\+?[\d\s().-]{7,}$|^\S+@\S+$/.test(phone)) return res.json({ ok: false, error: "Enter a phone number like +1 206 555 0123 (or your iMessage email)." });
  const handle = phone.includes("@") ? phone : `+${phone.replace(/\D/g, "").replace(/^(\d{10})$/, "1$1")}`;
  try {
    console.log(`[photon] Text me -> ${handle}`);
    const r = await sayHello(handle);
    console.log(`[photon] sent to ${handle}${r.line ? ` from ${r.line}` : ""}`);
    if (r.line && !process.env.COURT_NUMBER) writeEnv({ COURT_NUMBER: r.line });
    res.json({ ok: true, handle, line: r.line });
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    console.error(`[photon] Text me to ${handle} failed:`, msg);
    res.json({
      ok: false,
      handle,
      error: /not allowed|allowlist/i.test(msg)
        ? `Photon won't text ${handle} yet. Add it under Users in the Photon dashboard (app.photon.codes), then try again.`
        : msg.slice(0, 240),
    });
  }
});
