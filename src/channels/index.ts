// Channel registry. Space ids are prefixed by channel ("sim:group", "photon:<id>") so proactive
// messages (e.g. "it's time to buy") can be routed back to wherever the family talks.
import { addChat } from "../store.ts";

type Sender = (spaceId: string, text: string) => Promise<void>;
const senders = new Map<string, Sender>();

export function registerChannel(prefix: string, send: Sender) {
  senders.set(prefix, send);
}

export async function sendTo(spaceId: string, text: string, isPrivate = false) {
  addChat({ spaceId, from: "court", text, private: isPrivate });
  const send = senders.get(spaceId.split(":")[0]);
  if (send) await send(spaceId, text);
}
