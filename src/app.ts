// The court's web app: dashboard, setup, case file, simulator, demo controls, and the Photon webhook.
// Started by server.ts (laptop / container: long-running) or vercel.ts (serverless).
import "dotenv/config";
import express from "express";
import { fileURLToPath } from "node:url";
import { handle } from "./agent.ts";
import { forgetClaims, memberForHandle } from "./claims.ts";
import { registerChannel, sendTo } from "./channels/index.ts";
import { handleWebhook, photonStatus } from "./channels/photon.ts";
import { isAdmin, setupRouter } from "./setup.ts";
import { authRouter } from "./auth.ts";
import { savedMemberIds } from "./data.ts";
import { backend, flush, reload } from "./db.ts";
import { background, keepAlive, serverless, settle } from "./runtime.ts";
import { dashboardRouter } from "./dashboard.ts";
import { demoRouter, seedCart } from "./demo.ts";
import { shareRouter } from "./share.ts";
import { deliver } from "./feed.ts";
import { advanceTrial, cartPrice, readyHolds, usd } from "./engine.ts";
import { addChat, bus, changed, logActivity, persist, publicState, reset, state, trialOpts, world } from "./store.ts";
import { tapbackLog, tapbackText } from "./tapback.ts";
import { caseFileUrl } from "./share.ts";

export const app = express();
app.set("trust proxy", true); // hosted: req.secure / protocol come from the host's proxy

// Serverless (Vercel): start each request from what's saved in MongoDB (another copy of the court may have
// changed it), and before the function freezes, finish background work (replies, family feed) and save.
let inflight = 0;
if (serverless) {
  app.use(async (_req, res, next) => {
    if (inflight++ === 0) await reload().catch((err) => console.error("[db] reload failed:", err));
    const closed = new Promise<void>((r) => res.on("close", () => r()));
    void keepAlive(
      closed
        .then(settle)
        .then(() => {
          persist();
          return flush();
        })
        .finally(() => inflight--),
    );
    next();
  });
}

// Photon webhook (Vercel): Photon POSTs each inbound iMessage here. Needs the exact raw body for the
// signature check, so it's registered before the JSON parser.
app.post("/api/photon/webhook", express.raw({ type: "*/*", limit: "25mb" }), async (req, res) => {
  try {
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v ?? "")]));
    const r = await handleWebhook(new Uint8Array(req.body as Buffer), headers);
    res.status(r.status).set(r.headers).send(Buffer.from(r.body));
  } catch (err) {
    console.error("[photon] webhook failed:", err);
    res.status(500).json({ ok: false }); // 5xx: Photon retries
  }
});

app.use(express.json({ limit: "12mb" }));
app.use(authRouter(isAdmin)); // Sign in with Google / Apple for parents
app.use(setupRouter); // before static files, so /setup stays local-only

// Opening the app once through a tunnel (cloudflared/ngrok/localtunnel) or a host's default address teaches
// the court its public URL, so the case-file links it texts open on phones. Set PUBLIC_URL to pin it instead.
app.use((req, _res, next) => {
  const host = req.headers.host ?? "";
  const tunnel = /\.(trycloudflare\.com|ngrok-free\.app|ngrok\.io|loca\.lt|run\.app|onrender\.com|fly\.dev|up\.railway\.app|herokuapp\.com|vercel\.app)$/i.test(host.split(":")[0]);
  const current = process.env.PUBLIC_URL ?? "";
  if (tunnel && (!current || current.includes("localhost"))) {
    process.env.PUBLIC_URL = `https://${host}`;
    console.log(`[url] case-file links now use ${process.env.PUBLIC_URL}`);
  }
  next();
});
// Health check for hosts (and a quick "is it saving to MongoDB?" from the terminal).
app.get("/healthz", (_req, res) => res.json({ ok: true, db: backend, photon: photonStatus.state, day: state.day, cart: state.cart.length }));

// Home: a brand-new court starts at setup (signing in first when hosted); after that, the dashboard for
// whoever runs the court, and the family's case file for anyone else (a phone via the tunnel).
app.get("/", (req, res) => {
  const fresh = savedMemberIds().length === 0;
  if (isAdmin(req)) return fresh ? res.redirect("/welcome") : res.sendFile(fileURLToPath(new URL("../public/dashboard.html", import.meta.url)));
  res.redirect(fresh ? "/login?next=%2Fwelcome" : "/cart");
});
app.use(dashboardRouter);
app.use(demoRouter);
app.use(shareRouter);
app.use(express.static(fileURLToPath(new URL("../public/", import.meta.url)), { extensions: ["html"] }));


// ---- Live updates (Server-Sent Events) for the cart page + simulator
app.get("/api/events", (req, res) => {
  // Serverless functions can't hold a stream open: 204 tells the page to poll /api/state instead.
  if (serverless) return res.status(204).end();
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  const withChat = req.query.chat === "1" && isAdmin(req); // only the simulator gets chat (it includes DMs)
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("state", publicState());
  if (withChat) state.chat.forEach((c) => send("chat", c));
  const onState = (s: unknown) => send("state", s);
  const onChat = (c: unknown) => withChat && send("chat", c);
  bus.on("state", onState);
  bus.on("chat", onChat);
  req.on("close", () => {
    bus.off("state", onState);
    bus.off("chat", onChat);
  });
});

app.get("/api/state", (req, res) =>
  res.json(req.query.chat === "1" && isAdmin(req) ? { ...publicState(), chat: state.chat.map(({ image: _i, ...c }) => c) } : publicState()),
);

// ---- Simulator channel: a fake group chat + DMs, so the team can build without Photon
registerChannel("sim", async () => {}); // messages already land in the store via sendTo -> addChat

app.post("/api/sim/message", async (req, res) => {
  const body = req.body as { memberId: string; text?: string; dm?: boolean; image?: string; tapback?: string; lineId?: string };
  let { text = "", dm = false, image } = body;
  // "new:<phone>" simulates a phone the court has never seen (tests in-chat onboarding)
  const phone = body.memberId.startsWith("new:") ? body.memberId.slice(4) : undefined;
  const memberId = phone ? memberForHandle(phone) : body.memberId;
  const spaceId = dm ? `sim:dm:${body.memberId}` : "sim:group";
  if (body.tapback) {
    // Same rules as a real iMessage tapback (tapback.ts): 👎 on a ruling appeals, ❓ asks why, the rest are applause.
    const target = state.chat.find((l) => l.id === body.lineId);
    addChat({ spaceId, from: memberId ?? "unknown", text: tapbackLog(body.tapback, target?.text), private: dm });
    const asked = memberId ? tapbackText(body.tapback, target?.text, target?.from === "court") : undefined;
    if (!asked) return void res.json({ ok: true, replied: false });
    text = asked;
    image = undefined;
  } else addChat({ spaceId, from: memberId ?? "unknown", text, private: dm, image });
  const img = image?.match(/^data:(.+?);base64,(.+)$/);
  try {
    const reply = await handle({ spaceId, isGroup: !dm, memberId, handle: phone, text, addressed: !!body.tapback, image: img ? { mimeType: img[1], base64: img[2] } : undefined });
    if (reply) await sendTo(spaceId, reply, dm);
    res.json({ ok: true, replied: !!reply });
  } catch (err) {
    console.error(err);
    await sendTo(spaceId, "⚠️ The court hit an error. Check the server log.", dm);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ---- Demo controls
app.post("/api/demo/advance", async (req, res) => {
  const days = Number(req.body?.days ?? 41);
  const newDay = state.day + days;
  const due = readyHolds(state.trial, newDay);
  state.day = newDay;
  state.trial = advanceTrial(world, state.cart, state.trial, newDay, trialOpts());
  changed();
  // Held items whose day has come: tell everyone (each person's iMessage chat, plus the simulator group).
  for (const r of due) {
    const who = (world.household.members.find((m) => m.id === r.memberId)?.name ?? "").split(/\s+/)[0];
    const text = `⏳➡️✅ ${who}, it's time. Your ${r.proposed?.label} is ready at ${usd(r.heldCost)} instead of ${usd(r.originalCost)}. Waiting saved ${usd(r.savings)}. Case file: ${caseFileUrl()}`;
    logActivity([text]);
    await deliver(text, undefined, "photon"); // the family group chat if there is one, else each 1:1 chat
    if (!state.groupSpaceId?.startsWith("photon:")) await sendTo(state.groupSpaceId ?? "sim:group", text);
  }
  res.json({ day: state.day, announced: due.length });
});

app.post("/api/demo/seed", (_req, res) => {
  seedCart();
  res.json(publicState());
});

// Plays the family argument into the group chat line by line (no LLM calls: free, instant, repeatable).
const ARGUMENT: [string, string][] = [
  ["maya", "my phone is SO slow 😭 literally everyone at school has the 17 Pro Max"],
  ["maya", "https://store.example.com/iphone-17-pro-max?storage=512"],
  ["marco", "honestly mine's getting old too. if we're doing this I want the 17 Pro"],
  ["elena", "my Pixel dies by 2pm every single day. Pixel 10 Pro for me"],
  ["maya", "so we're ALL upgrading?? 🙏🙏"],
  ["marco", "let's just order everything tonight"],
];
let arguing = false;
app.post("/api/demo/argue", async (_req, res) => {
  if (arguing) return res.json({ ok: false, busy: true });
  arguing = true;
  res.json({ ok: true });
  background(playArgument(state.groupSpaceId ?? "sim:group"));
});

async function playArgument(spaceId: string) {
  try {
    for (const [from, text] of ARGUMENT) {
      addChat({ spaceId, from, text, private: false });
      // Goes through the real agent: chatter stays unanswered (taste), the pasted link gets filed.
      const reply = await handle({ spaceId, isGroup: true, memberId: from, text });
      if (reply) await sendTo(spaceId, reply);
      await new Promise((r) => setTimeout(r, 1100));
    }
    seedCart();
    const sticker = state.cart.reduce((s, i) => s + cartPrice(world, i), 0);
    await sendTo(spaceId, `📥 Entered into the family cart: 17 Pro Max 512GB (Maya), 17 Pro 256GB (Marco), Pixel 10 Pro 256GB (Elena). Sticker total ${usd(sticker)}. Nobody checks out until the court rules. Say "court, rule".`);
  } finally {
    arguing = false;
  }
}

app.post("/api/demo/reset", (_req, res) => {
  reset();
  forgetClaims(); // the simulated "new phone" has to introduce itself again
  res.json({ ok: true });
});
