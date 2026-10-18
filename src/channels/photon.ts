// Photon (Spectrum SDK) channel: a real iMessage number.
// Docs: https://photon.codes/docs/spectrum-ts  ·  dashboard: https://app.photon.codes
//
// On Photon's free/shared plan each person texts the court 1:1 (no group chats; those need a
// dedicated line). That's fine: every 1:1 chat feeds the same household cart, and "it's time"
// alerts go to everyone. Photon only delivers to numbers added under Users in the dashboard.
//
// Two ways in:
//  - Laptop / container: startPhoton() keeps a streaming connection open (`for await app.messages`).
//  - Vercel: Photon POSTs each message to /api/photon/webhook (see handleWebhook). No stream; the
//    SDK client is created on demand just to verify webhooks and send replies.
import { Spectrum } from "spectrum-ts";
import { effect as withEffect, imessage } from "spectrum-ts/providers/imessage";
import type { Message, Space } from "spectrum-ts";
import { handle as handleMessage } from "../agent.ts";
import { memberForHandle, welcome, welcomeQuestion } from "../claims.ts";
import { background, serverless } from "../runtime.ts";
import { addChat, state } from "../store.ts";
import { registerChannel, sendTo } from "./index.ts";
import { tapbackLog, tapbackText } from "../tapback.ts";

type SpectrumApp = Awaited<ReturnType<typeof Spectrum>>;

const spaces = new Map<string, Space>();
const handleSpace = new Map<string, string>(); // sender handle -> their 1:1 space id
let app: SpectrumApp | undefined;
let connecting: Promise<SpectrumApp | undefined> | undefined;
let generation = 0; // bumps on restart so an old message loop stops

export const photonStatus: { state: "off" | "connecting" | "connected" | "error"; error?: string; line?: string } = { state: "off" };

/** Every 1:1 / group conversation the court has had over Photon (for broadcasts). */
export const photonSpaceIds = () => [...spaces.keys()].map((id) => `photon:${id}`);

function lineOf(space: Space): string | undefined {
  try {
    const phone = (imessage as unknown as (s: Space) => { phone?: string })(space)?.phone;
    return phone && /\d{7,}/.test(phone.replace(/\D/g, "")) ? phone : undefined; // shared plans report "shared", not a number
  } catch {
    return undefined;
  }
}

/** Create the SDK client (no stream). Shared by both modes; on Vercel it's created on the first request that needs it. */
async function connect(): Promise<SpectrumApp | undefined> {
  const { PHOTON_PROJECT_ID: projectId, PHOTON_PROJECT_SECRET: projectSecret } = process.env;
  if (!projectId || !projectSecret) {
    photonStatus.state = "off";
    return undefined;
  }
  photonStatus.state = "connecting";
  photonStatus.error = undefined;
  try {
    app = await Spectrum({ projectId, projectSecret, providers: [imessage.config()] });
  } catch (err) {
    photonStatus.state = "error";
    photonStatus.error = String((err as Error).message ?? err);
    console.error("[photon] failed to start:", photonStatus.error);
    return undefined;
  }
  registerChannel("photon", async (spaceId, text, effect) => {
    const space = spaces.get(spaceId.slice("photon:".length));
    if (!space) return;
    if (effect) {
      try { await space.send(withEffect(text, imessage.effect.message[effect])); return; }
      catch (e) { console.warn(`[photon] ${effect} effect failed, sending plain:`, (e as Error).message); }
    }
    await space.send(text);
  });
  photonStatus.state = "connected";
  reconnectDelay = 2_000; // healthy again: next drop retries quickly
  return app;
}

/** The SDK client, connecting first if needed (waits for a connect already in progress). */
async function ensureApp(): Promise<SpectrumApp> {
  if (app && photonStatus.state === "connected") return app;
  connecting ??= connect().finally(() => (connecting = undefined));
  const a = await connecting;
  if (!a) {
    throw new Error(photonStatus.state === "error" ? `Photon couldn't connect: ${photonStatus.error}` : "Photon isn't connected. Paste the Project ID and Secret in step 2 on /setup.");
  }
  return a;
}

/** Delivery is at-least-once (stream and webhooks both): skip messages we've already handled. Saved, so it works across serverless copies. */
function alreadySeen(id: string) {
  if (state.seenIds.includes(id)) return true;
  state.seenIds.push(id);
  if (state.seenIds.length > 300) state.seenIds.splice(0, state.seenIds.length - 300);
  return false;
}

/** One inbound iMessage, from the stream or a webhook: run it through the court and reply. */
async function onInbound(space: Space, message: Message) {
  if (message.direction === "outbound" || alreadySeen(message.id)) return;
  spaces.set(space.id, space);
  photonStatus.line ??= lineOf(space);

  const content = message.content as { type: string; text?: string; mimeType?: string; read?: () => Promise<Buffer>; emoji?: string; target?: Message };
  if (content.type === "reaction") return onTapback(space, message, content.emoji ?? "", content.target);
  let text = content.type === "text" ? content.text ?? "" : "";
  let image: { mimeType: string; base64: string } | undefined;
  if (content.type === "attachment" && content.mimeType?.startsWith("image/") && content.read) {
    image = { mimeType: content.mimeType, base64: (await content.read()).toString("base64") };
    text ||= "[photo]";
  }
  if (!text && !image) return; // typing, read receipts, polls...

  const isGroup = (space as unknown as { type?: string }).type === "group";
  const spaceId = `photon:${space.id}`;
  const handle = message.sender?.id;
  if (handle && !isGroup) handleSpace.set(handle, space.id);
  const memberId = memberForHandle(handle);
  addChat({ spaceId, from: memberId ?? handle ?? "unknown", text, private: !isGroup, image: image ? `data:${image.mimeType};base64,${image.base64}` : undefined });
  console.log(`[photon] ${handle} (${memberId ?? "new"}): ${text.slice(0, 80)}`);

  try {
    const reply = await space.responding(() => handleMessage({ spaceId, isGroup, memberId, handle, text, image }));
    if (reply) await sendTo(spaceId, reply, !isGroup);
  } catch (err) {
    console.error("[photon] handler failed", err);
  }
}

/** The text of a message the court sent (plain, or wrapped in an iMessage effect). */
function textOf(m?: Message): string | undefined {
  const c = m?.content as { type: string; text?: string; content?: { type: string; text?: string } } | undefined;
  return c?.type === "text" ? c.text : c?.type === "effect" && c.content?.type === "text" ? c.content.text : undefined;
}

/** A tapback: 👎 on a ruling appeals it, ❓ asks why (see tapback.ts). Others are logged only. */
async function onTapback(space: Space, message: Message, emoji: string, target?: Message) {
  const isGroup = (space as unknown as { type?: string }).type === "group";
  const spaceId = `photon:${space.id}`;
  const handle = message.sender?.id;
  const memberId = memberForHandle(handle);
  if (!memberId) return; // strangers get the welcome when they text, not when they tap
  // Tapping 👎 twice (or off and on) is still one appeal.
  if (target?.id && alreadySeen(`tap:${target.id}:${handle}:${emoji}`)) return;
  const targetText = textOf(target);
  addChat({ spaceId, from: memberId, text: tapbackLog(emoji, targetText), private: !isGroup });
  const text = tapbackText(emoji, targetText, target?.direction !== "inbound"); // the court's own message
  if (!text) return;
  console.log(`[photon] ${handle} (${memberId}) tapped ${emoji}: "${text}"`);
  try {
    const reply = await space.responding(() => handleMessage({ spaceId, isGroup, memberId, handle, text, addressed: true }));
    if (reply) await sendTo(spaceId, reply, !isGroup);
  } catch (err) {
    console.error("[photon] tapback handler failed", err);
  }
}

/** Laptop / container: connect and keep a streaming connection open. On Vercel this only connects (webhooks bring messages). */
export async function startPhoton() {
  const myGen = ++generation;
  if (app) {
    await app.stop().catch(() => {});
    app = undefined;
  }
  if (!process.env.PHOTON_PROJECT_ID || !process.env.PHOTON_PROJECT_SECRET) {
    photonStatus.state = "off";
    console.log("[photon] PHOTON_PROJECT_ID/SECRET not set: real phone channel disabled (simulator still works)");
    return;
  }
  const a = await connect();
  if (!a) return scheduleReconnect(myGen); // couldn't connect (network blip?): try again shortly
  if (serverless) return;
  console.log("[photon] connected, listening for messages");
  try {
    for await (const [space, message] of a.messages) {
      if (myGen !== generation) break;
      await onInbound(space, message);
    }
    if (myGen === generation) throw new Error("message stream ended");
  } catch (err) {
    if (myGen !== generation) return; // a deliberate restart replaced this loop
    // Don't keep claiming "connected" while nobody is listening: report it, then reconnect.
    photonStatus.state = "error";
    photonStatus.error = `Lost the iMessage connection (${(err as Error).message}). Reconnecting…`;
    console.error("[photon]", photonStatus.error);
    scheduleReconnect(myGen);
  }
}

let reconnectDelay = 2_000;
let reconnectTimer: NodeJS.Timeout | undefined;
/** Retry startPhoton with backoff (2s → 4s → … capped at 60s); a successful connect resets it. */
function scheduleReconnect(fromGen: number) {
  if (serverless || fromGen !== generation || reconnectTimer) return;
  if (!process.env.PHOTON_PROJECT_ID || !process.env.PHOTON_PROJECT_SECRET) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
  console.log(`[photon] reconnecting in ${Math.round(delay / 1000)}s`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    if (fromGen === generation) startPhoton().catch((err) => console.error("[photon] reconnect failed:", err));
  }, delay);
}

/**
 * Vercel: one webhook delivery from Photon. `body` must be the exact raw bytes. The SDK verifies the
 * signature (SPECTRUM_WEBHOOK_SECRET) and calls back with each message after it has computed the
 * response; that work is tracked with background() so the function stays alive until replies are sent.
 */
export async function handleWebhook(body: Uint8Array, headers: Record<string, string>) {
  const a = await ensureApp();
  return a.webhook({ body, headers }, (space, message) => {
    const work = onInbound(space, message);
    background(work);
    return work;
  });
}

/** The court texts first, so the tester learns its number. The handle must be added under Users in the Photon dashboard. */
export async function sayHello(handle: string): Promise<{ line?: string }> {
  const a = await ensureApp();
  const im = (imessage as unknown as (a: SpectrumApp) => {
    user(id: string): Promise<unknown>;
    space: { create(u: unknown): Promise<Space> };
  })(a);
  const space = await im.space.create(await im.user(handle));
  spaces.set(space.id, space);
  handleSpace.set(handle, space.id);
  const memberId = memberForHandle(handle);
  const text = memberId ? welcome(memberId) : welcomeQuestion();
  await sendTo(`photon:${space.id}`, text, true);
  const line = lineOf(space);
  if (line) photonStatus.line = line;
  return { line };
}

/** Is a Photon project configured (so it's worth trying to send)? On Vercel the client connects on demand. */
export const photonReady = () =>
  !!process.env.PHOTON_PROJECT_ID && !!process.env.PHOTON_PROJECT_SECRET && photonStatus.state !== "error" && (serverless || photonStatus.state === "connected");

/** What to show for Photon. On Vercel each request starts fresh and connects only when it sends, so a configured
 *  court that hasn't sent yet is "ready" (texts arrive by webhook), not "off". */
export const photonShown = (): "off" | "connecting" | "connected" | "error" | "ready" =>
  serverless && photonStatus.state === "off" && !!process.env.PHOTON_PROJECT_ID && !!process.env.PHOTON_PROJECT_SECRET ? "ready" : photonStatus.state;

/** Text one person in their 1:1 chat with the court (reuses the chat, or opens it). Returns the space id. */
/** Is this Photon conversation reachable from this process (a group the court has seen since it started)? */
export const hasSpace = (spaceId: string) => spaces.has(spaceId.replace(/^photon:/, ""));

export async function sendToHandle(handle: string, text: string): Promise<string> {
  const a = await ensureApp();
  let id = handleSpace.get(handle);
  if (!id || !spaces.has(id)) {
    const im = (imessage as unknown as (a: SpectrumApp) => {
      user(id: string): Promise<unknown>;
      space: { create(u: unknown): Promise<Space> };
    })(a);
    const space = await im.space.create(await im.user(handle));
    spaces.set(space.id, space);
    handleSpace.set(handle, space.id);
    id = space.id;
  }
  await sendTo(`photon:${id}`, text, true);
  return id;
}

/** Tests: feed one message through the same path a real Photon delivery takes. */
export const receive = onInbound;
