// /setup: paste keys, check what's connected, and have the court text your phone.
// Only reachable from this computer, or (on a hosted server) by someone who opened the ADMIN_TOKEN link once.
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { Router, type NextFunction, type Request, type Response } from "express";
import { photonStatus, sayHello, startPhoton } from "./channels/photon.ts";
import { addPhotonUser, dashboardToken } from "./photonUsers.ts";
import { loadHouseholdLocal, loadWorld, savedMemberIds, saveHouseholdLocal } from "./data.ts";
import { backend, flush, get, put } from "./db.ts";
import { changed, world } from "./store.ts";
import { claimedHandles } from "./claims.ts";

const envFile = fileURLToPath(new URL("../.env", import.meta.url));
const exampleFile = fileURLToPath(new URL("../.env.example", import.meta.url));

const EDITABLE = ["GEMINI_API_KEY", "GEMINI_MODELS", "PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET", "PUBLIC_URL", "COURT_NUMBER", "MONGODB_URI"] as const;
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
export function isLocal(req: Request) {
  const ip = req.socket.remoteAddress ?? "";
  const loopback = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  const host = (req.headers.host ?? "").split(":")[0];
  const forwarded = req.headers["x-forwarded-for"] || req.headers["cf-connecting-ip"] || req.headers["forwarded"];
  return loopback && (host === "localhost" || host === "127.0.0.1") && !forwarded;
}

const ADMIN_COOKIE = "cc_admin";
const sameSecret = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
const adminCookie = (req: Request) =>
  (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${ADMIN_COOKIE}=`))?.slice(ADMIN_COOKIE.length + 1);

/** The computer running the court, or (hosted) a browser that opened /?key=ADMIN_TOKEN once. */
export function isAdmin(req: Request) {
  if (isLocal(req)) return true;
  const token = process.env.ADMIN_TOKEN;
  const cookie = adminCookie(req);
  return !!token && !!cookie && sameSecret(decodeURIComponent(cookie), token);
}

/** `?key=ADMIN_TOKEN` on any page: remember this browser for 30 days, then drop the key from the address bar. */
export function adminLogin(req: Request, res: Response, next: NextFunction) {
  const token = process.env.ADMIN_TOKEN;
  const key = typeof req.query.key === "string" ? req.query.key : undefined;
  if (!token || !key || req.method !== "GET") return next();
  if (!sameSecret(key, token)) return res.status(403).send("That admin key isn't right.");
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.setHeader("Set-Cookie", `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure ? "; Secure" : ""}`);
  const url = new URL(req.originalUrl, "http://x");
  url.searchParams.delete("key");
  res.redirect(url.pathname + url.search);
}

export function localOnly(req: Request, res: Response, next: NextFunction) {
  if (isAdmin(req)) return next();
  res
    .status(403)
    .send("This page only works on the computer running Cart Court (http://localhost:3000), or on a hosted court after opening its admin link (/?key=…). The family's case file is at /cart.");
}

const mask = (v?: string) => (v ? `••••${v.slice(-4)}` : "");

export const setupRouter = Router();
// The dashboard, setup and demo controls are for whoever runs the court. Phones only get /cart.
setupRouter.use(adminLogin);
setupRouter.use(["/setup", "/setup.html", "/api/setup", "/dashboard", "/dashboard.html", "/api/dashboard", "/sim", "/sim.html", "/api/sim", "/api/demo"], localOnly);

setupRouter.get("/api/setup", (_req, res) => {
  res.json({
    gemini: { configured: !!process.env.GEMINI_API_KEY, hint: mask(process.env.GEMINI_API_KEY), models: process.env.GEMINI_MODELS ?? "" },
    photon: {
      configured: !!(process.env.PHOTON_PROJECT_ID && process.env.PHOTON_PROJECT_SECRET),
      ...photonStatus,
      projectHint: mask(process.env.PHOTON_PROJECT_ID),
      autoUsers: !!dashboardToken(), // can the court add numbers under Users by itself?
    },
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
  const photonChanged =
    (updates.PHOTON_PROJECT_ID && updates.PHOTON_PROJECT_ID !== process.env.PHOTON_PROJECT_ID) ||
    (updates.PHOTON_PROJECT_SECRET && updates.PHOTON_PROJECT_SECRET !== process.env.PHOTON_PROJECT_SECRET);
  writeEnv(updates);
  if (photonChanged || ((updates.PHOTON_PROJECT_ID || updates.PHOTON_PROJECT_SECRET) && photonStatus.state !== "connected")) {
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

// ---- Household: real names + phone numbers, entered before anyone texts.
// Rows nobody filled in stay example data: greyed out on /setup, never saved, never texted.

/** "+1 (206) 555-0123" / "2065550123" -> "+12065550123"; emails pass through. */
function normalizeHandle(raw: string): string | undefined {
  const v = raw.trim();
  if (!v) return undefined;
  if (v.includes("@")) return /^\S+@\S+\.\S+$/.test(v) ? v.toLowerCase() : undefined;
  const d = v.replace(/\D/g, "");
  if (d.length < 7) return undefined;
  return `+${d.length === 10 ? `1${d}` : d}`;
}

const ROLES = ["parent", "teen", "kid", "grandparent", "roommate", "partner", "other"];

setupRouter.get("/api/setup/household", (_req, res) => {
  const example = loadWorld({ local: false }).household; // pristine example values, shown greyed for unsaved rows
  const saved = loadHouseholdLocal().members;
  res.json({
    roles: ROLES,
    phones: [...new Set([...example.members.map((m) => m.device.model), ...world.catalog.phones.map((p) => p.name)])],
    members: world.household.members.map((m) => {
      const ex = example.members.find((x) => x.id === m.id)!;
      const s = saved[m.id];
      return {
        id: m.id,
        saved: !!s,
        example: { name: ex.name, role: ex.role, phoneModel: ex.device.model },
        name: s?.name ?? "",
        role: s?.role ?? "",
        phoneModel: s?.phoneModel ?? "",
        handle: s?.handles?.[0] ?? claimedHandles(m.id)[0] ?? "",
      };
    }),
  });
});

setupRouter.post("/api/setup/household", (req, res) => {
  const input = (req.body?.members ?? []) as { id: string; name?: string; phone?: string; role?: string; phoneModel?: string }[];
  const local = loadHouseholdLocal();
  const problems: string[] = [];
  for (const row of input) {
    if (!world.household.members.some((x) => x.id === row.id)) continue;
    const name = (row.name ?? "").trim();
    const phone = (row.phone ?? "").trim();
    if (!name && !phone) {
      delete local.members[row.id]; // left blank: stays an example
      continue;
    }
    if (!name) {
      problems.push(`Add a name for ${phone}`);
      continue;
    }
    const handle = phone ? normalizeHandle(phone) : undefined;
    if (phone && !handle) problems.push(`${name}: "${phone}" isn't a phone number or email`);
    local.members[row.id] = {
      name,
      handles: handle ? [handle] : (local.members[row.id]?.handles ?? []),
      role: ROLES.includes(row.role ?? "") ? row.role : undefined,
      phoneModel: (row.phoneModel ?? "").trim() || undefined,
    };
  }
  saveHouseholdLocal(local);
  // Re-apply names/roles/phones from disk onto the live household (example rows go back to example values).
  const fresh = loadWorld().household.members;
  for (const m of world.household.members) {
    const f = fresh.find((x) => x.id === m.id)!;
    m.name = f.name;
    m.role = f.role;
    m.handles = f.handles;
    m.device.model = f.device.model;
  }
  changed();
  res.json({ ok: problems.length === 0, problems, saved: Object.keys(local.members).length });
});

// Remembers who already got a welcome, so "Text everyone" after adding one person only texts that person.
const welcomed = get<string[]>("welcomed", []);
export const wasWelcomed = (handle: string) => welcomed.includes(handle);

setupRouter.post("/api/setup/hello-all", async (req, res) => {
  const resend = req.body?.resend === true;
  const saved = savedMemberIds();
  const canRegister = !!dashboardToken();
  const targets = world.household.members
    .filter((m) => saved.includes(m.id))
    .flatMap((m) => m.handles.map((handle) => ({ name: m.name, handle })));
  const todo = resend ? targets : targets.filter((t) => !welcomed.includes(t.handle));
  const skipped = targets.length - todo.length;

  // Everyone at once: register with Photon (if logged in), then text the welcome.
  const results = await Promise.all(
    todo.map(async ({ name, handle }) => {
      try {
        if (canRegister) {
          await addPhotonUser(name, handle).catch((e) => console.warn(`[photon] couldn't add ${handle} under Users:`, (e as Error).message));
        }
        const r = await sayHello(handle);
        if (r.line && !process.env.COURT_NUMBER) writeEnv({ COURT_NUMBER: r.line });
        if (!welcomed.includes(handle)) welcomed.push(handle);
        console.log(`[photon] welcomed ${name} at ${handle}`);
        return { name, handle, ok: true };
      } catch (err) {
        const msg = String((err as Error).message ?? err);
        console.error(`[photon] welcome to ${name} (${handle}) failed:`, msg);
        return {
          name,
          handle,
          ok: false,
          error: /not allowed|allowlist/i.test(msg)
            ? canRegister ? "Photon hasn't approved this number yet. Try again in a minute" : "not approved in Photon yet (see the tip above)"
            : msg.slice(0, 160),
        };
      }
    }),
  );
  put("welcomed", welcomed);
  res.json({ ok: results.every((r) => r.ok), results, skipped, total: targets.length, line: photonStatus.line, canRegister });
});

// ---- MongoDB: paste an Atlas connection string, test it, save it, and switch the court over.

/** "mongodb+srv://user:pw@cluster0.abcd.mongodb.net/?…" -> "cluster0.abcd.mongodb.net" (never the password). */
const mongoHost = (uri?: string) => uri?.match(/@([^/?]+)/)?.[1] ?? "";

setupRouter.get("/api/setup/db", (_req, res) => {
  res.json({ backend, host: backend === "mongodb" ? mongoHost(process.env.MONGODB_URI) : "", configured: !!process.env.MONGODB_URI });
});

setupRouter.post("/api/setup/mongodb", async (req, res) => {
  const uri = String(req.body?.uri ?? "").trim();
  if (!/^mongodb(\+srv)?:\/\//.test(uri)) {
    return res.json({ ok: false, error: "That doesn't look like a MongoDB connection string. It should start with mongodb+srv://" });
  }
  if (/<(db_)?password>/i.test(uri)) {
    return res.json({ ok: false, error: "Replace <db_password> in the string with the database user's password you created." });
  }
  try {
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000, appName: "cart-court-setup" });
    await client.connect();
    await client.db(process.env.MONGODB_DB || "cartcourt").command({ ping: 1 });
    await client.close();
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    console.warn("[db] connection test failed:", msg);
    return res.json({
      ok: false,
      error: /auth|authentication|bad auth/i.test(msg)
        ? "Wrong username or password. In Atlas → Database Access, check the user (or reset its password) and paste the string again."
        : /ENOTFOUND|querySrv|ENODATA/i.test(msg)
          ? "Couldn't find that cluster address. Copy the whole connection string again from Atlas → Connect → Drivers."
          : /timed out|Server selection|ETIMEDOUT|ECONNREFUSED|ReplicaSetNoPrimary/i.test(msg)
            ? "Couldn't reach the cluster. In Atlas → Network Access, add your current IP address (for the hackathon, 0.0.0.0/0 also works), wait a minute, then try again."
            : msg.slice(0, 200),
    });
  }
  writeEnv({ MONGODB_URI: uri });
  await flush(); // everything saved so far gets copied into MongoDB on the restart
  // Under `npm run dev` (node --watch), touching a watched file restarts the server onto MongoDB.
  const watching = process.execArgv.some((a) => a.startsWith("--watch"));
  if (watching) {
    setTimeout(() => {
      const now = new Date();
      utimesSync(fileURLToPath(new URL("./db.ts", import.meta.url)), now, now);
    }, 400);
  }
  res.json({ ok: true, host: mongoHost(uri), restarting: watching });
});
