import "dotenv/config";
import express from "express";
import { fileURLToPath } from "node:url";
import { handle } from "./agent.ts";
import { forgetClaims, memberForHandle } from "./claims.ts";
import { registerChannel, sendTo } from "./channels/index.ts";
import { photonSpaceIds, photonStatus, startPhoton } from "./channels/photon.ts";
import { isAdmin, setupRouter } from "./setup.ts";
import { backend } from "./db.ts";
import { dashboardRouter } from "./dashboard.ts";
import { demoRouter, seedCart } from "./demo.ts";
import { shareRouter } from "./share.ts";
import { deliver } from "./feed.ts";
import { advanceTrial, readyHolds, usd } from "./engine.ts";
import { addChat, bus, changed, logActivity, publicState, reset, state, trialOpts, world } from "./store.ts";

const app = express();
app.use(express.json({ limit: "12mb" }));
app.use(setupRouter); // before static files, so /setup stays local-only

// Opening the app once through a tunnel (cloudflared/ngrok/localtunnel) or a host's default address teaches
// the court its public URL, so the case-file links it texts open on phones. Set PUBLIC_URL to pin it instead.
app.set("trust proxy", true); // hosted: req.secure / protocol come from the host's proxy
app.use((req, _res, next) => {
  const host = req.headers.host ?? "";
  const tunnel = /\.(trycloudflare\.com|ngrok-free\.app|ngrok\.io|loca\.lt|run\.app|onrender\.com|fly\.dev|up\.railway\.app|herokuapp\.com)$/i.test(host.split(":")[0]);
  const current = process.env.PUBLIC_URL ?? "";
  if (tunnel && (!current || current.includes("localhost"))) {
    process.env.PUBLIC_URL = `https://${host}`;
    console.log(`[url] case-file links now use ${process.env.PUBLIC_URL}`);
  }
  next();
});
// Health check for hosts (and a quick "is it saving to MongoDB?" from the terminal).
app.get("/healthz", (_req, res) => res.json({ ok: true, db: backend, photon: photonStatus.state, day: state.day, cart: state.cart.length }));

// Home: the dashboard for whoever runs the court; anyone else (a phone via the tunnel) gets the family's case file.
app.get("/", (req, res) => (isAdmin(req) ? res.sendFile(fileURLToPath(new URL("../public/dashboard.html", import.meta.url))) : res.redirect("/cart")));
app.use(dashboardRouter);
app.use(demoRouter);
app.use(shareRouter);
app.use(express.static(fileURLToPath(new URL("../public/", import.meta.url)), { extensions: ["html"] }));


// ---- Live updates (Server-Sent Events) for the cart page + simulator
app.get("/api/events", (req, res) => {
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

app.get("/api/state", (_req, res) => res.json(publicState()));

// ---- Simulator channel: a fake group chat + DMs, so the team can build without Photon
registerChannel("sim", async () => {}); // messages already land in the store via sendTo -> addChat

app.post("/api/sim/message", async (req, res) => {
  const body = req.body as { memberId: string; text?: string; dm?: boolean; image?: string };
  const { text = "", dm = false, image } = body;
  // "new:<phone>" simulates a phone the court has never seen (tests in-chat onboarding)
  const phone = body.memberId.startsWith("new:") ? body.memberId.slice(4) : undefined;
  const memberId = phone ? memberForHandle(phone) : body.memberId;
  const spaceId = dm ? `sim:dm:${body.memberId}` : "sim:group";
  addChat({ spaceId, from: memberId ?? "unknown", text, private: dm, image });
  const img = image?.match(/^data:(.+?);base64,(.+)$/);
  try {
    const reply = await handle({ spaceId, isGroup: !dm, memberId, handle: phone, text, image: img ? { mimeType: img[1], base64: img[2] } : undefined });
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
    const text = `⏳➡️✅ ${who}, it's time. Your ${r.proposed?.label} is ready at ${usd(r.heldCost)} instead of ${usd(r.originalCost)}. Waiting saved ${usd(r.savings)}. Case file: ${process.env.PUBLIC_URL ?? "http://localhost:3000"}/cart`;
    logActivity([text]);
    await deliver(text, undefined, "photon");
    await sendTo(state.groupSpaceId ?? "sim:group", text);
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
  const spaceId = state.groupSpaceId ?? "sim:group";
  try {
    for (const [from, text] of ARGUMENT) {
      addChat({ spaceId, from, text, private: false });
      // Goes through the real agent: chatter stays unanswered (taste), the pasted link gets filed.
      const reply = await handle({ spaceId, isGroup: true, memberId: from, text });
      if (reply) await sendTo(spaceId, reply);
      await new Promise((r) => setTimeout(r, 1100));
    }
    seedCart();
    const sticker = state.cart.reduce((s, i) => s + (world.catalog.phones.find((p) => p.id === i.phoneId)?.prices[String(i.storageGB)] ?? 0), 0);
    await sendTo(spaceId, `📥 Entered into the family cart: 17 Pro Max 512GB (Maya), 17 Pro 256GB (Marco), Pixel 10 Pro 256GB (Elena). Sticker total ${usd(sticker)}. Nobody checks out until the court rules. Say "court, rule".`);
  } finally {
    arguing = false;
  }
});

app.post("/api/demo/reset", (_req, res) => {
  reset();
  forgetClaims(); // the simulated "new phone" has to introduce itself again
  res.json({ ok: true });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Cart Court dashboard: http://localhost:${port}  ·  setup: /setup  ·  family case file: /cart`);
  console.log(process.env.GEMINI_API_KEY ? `[llm] Gemini (${process.env.GEMINI_MODELS || process.env.GEMINI_MODEL || "gemini-3.8-flash + fallbacks"})` : "[llm] no GEMINI_API_KEY: rules-only mode");
});
startPhoton().catch((err) => console.error("[photon] failed to start:", err));
