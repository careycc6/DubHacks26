// Photon 2.0 (Spectrum SDK) channel: a real number on iMessage, in DMs and group chats.
// Docs: https://github.com/photon-hq/spectrum-ts  ·  dashboard: https://app.photon.codes
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import type { Space } from "spectrum-ts";
import { handle } from "../agent.ts";
import { addChat, world } from "../store.ts";
import { registerChannel, sendTo } from "./index.ts";

const spaces = new Map<string, Space>();
const seen = new Set<string>(); // delivery is at-least-once: dedupe on message id

const memberFor = (handle?: string) =>
  world.household.members.find((m) => handle && m.handles.some((h) => handle.includes(h) || h.includes(handle)))?.id;

export async function startPhoton() {
  const { PHOTON_PROJECT_ID: projectId, PHOTON_PROJECT_SECRET: projectSecret } = process.env;
  if (!projectId || !projectSecret) {
    console.log("[photon] PHOTON_PROJECT_ID/SECRET not set: real phone channel disabled (simulator still works)");
    return;
  }
  const app = await Spectrum({ projectId, projectSecret, providers: [imessage.config()] });
  registerChannel("photon", async (spaceId, text) => {
    await spaces.get(spaceId.slice("photon:".length))?.send(text);
  });
  console.log("[photon] connected, listening for messages");

  for await (const [space, message] of app.messages) {
    if (message.direction === "outbound" || seen.has(message.id)) continue;
    seen.add(message.id);
    spaces.set(space.id, space);

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
    const memberId = memberFor(message.sender?.id);
    addChat({ spaceId, from: memberId ?? message.sender?.id ?? "unknown", text, private: !isGroup });

    try {
      const reply = await space.responding(() => handle({ spaceId, isGroup, memberId, text, image }));
      if (reply) await sendTo(spaceId, reply, !isGroup);
    } catch (err) {
      console.error("[photon] handler failed", err);
    }
  }
}
