// Photon (Spectrum SDK) channel: a real iMessage number.
// Docs: https://photon.codes/docs/spectrum-ts  ·  dashboard: https://app.photon.codes
//
// On Photon's free/shared plan each person texts the court 1:1 (no group chats; those need a
// dedicated line). That's fine: every 1:1 chat feeds the same household cart, and "it's time"
// alerts go to everyone. Photon only delivers to numbers added under Users in the dashboard.
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import type { Space } from "spectrum-ts";
import { handle as handleMessage } from "../agent.ts";
import { memberForHandle, welcome, welcomeQuestion } from "../claims.ts";
import { addChat } from "../store.ts";
import { registerChannel, sendTo } from "./index.ts";

type SpectrumApp = Awaited<ReturnType<typeof Spectrum>>;

const spaces = new Map<string, Space>();
const seen = new Set<string>(); // delivery is at-least-once: dedupe on message id
let app: SpectrumApp | undefined;
let generation = 0; // bumps on restart so an old message loop stops

export const photonStatus: { state: "off" | "connecting" | "connected" | "error"; error?: string; line?: string } = { state: "off" };

/** Every 1:1 / group conversation the court has had over Photon (for broadcasts). */
export const photonSpaceIds = () => [...spaces.keys()].map((id) => `photon:${id}`);

function lineOf(space: Space): string | undefined {
  try {
    return (imessage as unknown as (s: Space) => { phone?: string })(space)?.phone;
  } catch {
    return undefined;
  }
}

export async function startPhoton() {
  const { PHOTON_PROJECT_ID: projectId, PHOTON_PROJECT_SECRET: projectSecret } = process.env;
  const myGen = ++generation;
  if (app) {
    await app.stop().catch(() => {});
    app = undefined;
  }
  if (!projectId || !projectSecret) {
    photonStatus.state = "off";
    console.log("[photon] PHOTON_PROJECT_ID/SECRET not set: real phone channel disabled (simulator still works)");
    return;
  }
  photonStatus.state = "connecting";
  photonStatus.error = undefined;
  try {
    app = await Spectrum({ projectId, projectSecret, providers: [imessage.config()] });
  } catch (err) {
    photonStatus.state = "error";
    photonStatus.error = String((err as Error).message ?? err);
    console.error("[photon] failed to start:", photonStatus.error);
    return;
  }
  registerChannel("photon", async (spaceId, text) => {
    await spaces.get(spaceId.slice("photon:".length))?.send(text);
  });
  photonStatus.state = "connected";
  console.log("[photon] connected, listening for messages");

  for await (const [space, message] of app.messages) {
    if (myGen !== generation) break;
    if (message.direction === "outbound" || seen.has(message.id)) continue;
    seen.add(message.id);
    spaces.set(space.id, space);
    photonStatus.line ??= lineOf(space);

    const content = message.content as { type: string; text?: string; mimeType?: string; read?: () => Promise<Buffer> };
    let text = content.type === "text" ? content.text ?? "" : "";
    let image: { mimeType: string; base64: string } | undefined;
    if (content.type === "attachment" && content.mimeType?.startsWith("image/") && content.read) {
      image = { mimeType: content.mimeType, base64: (await content.read()).toString("base64") };
      text ||= "[photo]";
    }
    if (!text && !image) continue; // reactions, typing, read receipts...

    const isGroup = (space as unknown as { type?: string }).type === "group";
    const spaceId = `photon:${space.id}`;
    const handle = message.sender?.id;
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
}

/** The court texts first, so the tester learns its number. The handle must be added under Users in the Photon dashboard. */
export async function sayHello(handle: string): Promise<{ line?: string }> {
  // Right after Connect, Photon takes a few seconds to come up: wait instead of failing.
  for (let waited = 0; (!app || photonStatus.state === "connecting") && waited < 20_000; waited += 500) {
    if (photonStatus.state === "off" || photonStatus.state === "error") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!app || photonStatus.state !== "connected") {
    throw new Error(photonStatus.state === "error" ? `Photon couldn't connect: ${photonStatus.error}` : "Photon isn't connected. Paste the Project ID and Secret in step 2 on /setup.");
  }
  const im = (imessage as unknown as (a: SpectrumApp) => {
    user(id: string): Promise<unknown>;
    space: { create(u: unknown): Promise<Space> };
  })(app);
  const space = await im.space.create(await im.user(handle));
  spaces.set(space.id, space);
  const memberId = memberForHandle(handle);
  const text = memberId ? welcome(memberId) : welcomeQuestion();
  await sendTo(`photon:${space.id}`, text, true);
  const line = lineOf(space);
  if (line) photonStatus.line = line;
  return { line };
}
