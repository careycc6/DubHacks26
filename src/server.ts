import "dotenv/config";
import express from "express";
import { fileURLToPath } from "node:url";
import { handle } from "./agent.ts";
import { registerChannel, sendTo } from "./channels/index.ts";
import { startPhoton } from "./channels/photon.ts";
import { advanceTrial, readyHolds, usd } from "./engine.ts";
import { addChat, bus, changed, publicState, reset, state, world } from "./store.ts";
import { callTool } from "./tools.ts";

const app = express();
app.use(express.json({ limit: "12mb" }));
app.use(express.static(fileURLToPath(new URL("../public/", import.meta.url)), { extensions: ["html"] }));
app.get("/", (_req, res) => res.redirect("/sim"));

// ---- Live updates (Server-Sent Events) for the cart page + simulator
app.get("/api/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  const withChat = req.query.chat === "1"; // only the simulator gets chat (it includes DMs)
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
  const { memberId, text = "", dm = false, image } = req.body as { memberId: string; text?: string; dm?: boolean; image?: string };
  const spaceId = dm ? `sim:dm:${memberId}` : "sim:group";
  addChat({ spaceId, from: memberId, text, private: dm, image });
  const img = image?.match(/^data:(.+?);base64,(.+)$/);
  try {
    const reply = await handle({ spaceId, isGroup: !dm, memberId, text, image: img ? { mimeType: img[1], base64: img[2] } : undefined });
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
  state.trial = advanceTrial(world, state.cart, state.trial, newDay);
  changed();
  const target = state.groupSpaceId ?? "sim:group";
  for (const r of due) {
    const who = world.household.members.find((m) => m.id === r.memberId)?.name ?? "";
    await sendTo(target, `⏳➡️✅ ${who}, it's time. Your held item (${r.proposed?.label}) is ready at ${usd(r.heldCost)} instead of ${usd(r.originalCost)}. You saved ${usd(r.savings)} by waiting. Cart: ${process.env.PUBLIC_URL ?? "http://localhost:3000"}/cart`);
  }
  res.json({ day: state.day, announced: due.length });
});

app.post("/api/demo/seed", (_req, res) => {
  // The "family argued all evening" cart for the demo.
  callTool("add_phone_to_cart", { member: "marco", phone: "iphone-17-pro", storageGB: 256, addedBy: "marco" });
  callTool("add_phone_to_cart", { member: "elena", phone: "pixel-10-pro", storageGB: 256, addedBy: "elena" });
  callTool("add_phone_to_cart", { member: "maya", phone: "iphone-17-pro-max", storageGB: 512, addedBy: "maya" });
  callTool("add_addon_to_cart", { member: "maya", addon: "protection-360" });
  res.json(publicState());
});

app.post("/api/demo/reset", (_req, res) => {
  reset();
  res.json({ ok: true });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Cart Court on http://localhost:${port}  ·  simulator: /sim  ·  live cart: /cart`);
  console.log(process.env.GEMINI_API_KEY ? `[llm] Gemini (${process.env.GEMINI_MODEL || "gemini-2.5-flash"})` : "[llm] no GEMINI_API_KEY: rules-only mode");
});
startPhoton().catch((err) => console.error("[photon] failed to start:", err));
