// Family feed: on Photon's free plan everyone talks to the court in their own 1:1 chat, so when one
// person changes the shared cart (or the court rules), everyone else gets a one-line update.
// It feels like a group chat without needing one. Private things (DM notes, budget talk) never go out.
import { usd } from "./engine.ts";
import { sendTo } from "./channels/index.ts";
import { photonReady, sendToHandle } from "./channels/photon.ts";
import { state, world } from "./store.ts";

export interface Snapshot {
  cartIds: string[];
  trialRuns: number;
  exhibits: number;
  nest?: object;
  cartLabels: Record<string, string>;
}

const nameOf = (id?: string) => world.household.members.find((m) => m.id === id)?.name ?? "Someone";
const first = (name: string) => name.split(/\s+/)[0];

function cartLabel(itemId: string): string {
  const i = state.cart.find((x) => x.id === itemId);
  if (!i) return "an item";
  const p = world.catalog.phones.find((x) => x.id === i.phoneId);
  const a = world.catalog.addons.find((x) => x.id === i.addonId);
  return p ? `${p.name} ${i.storageGB}GB` : a?.name ?? "an add-on";
}

export function snapshot(): Snapshot {
  return {
    cartIds: state.cart.map((i) => i.id),
    trialRuns: state.trialRuns,
    exhibits: state.exhibits.length,
    nest: state.nest,
    cartLabels: Object.fromEntries(state.cart.map((i) => [i.id, cartLabel(i.id)])),
  };
}

/** One short line per thing that changed since `before`, written for the people who weren't there. */
export function describeChanges(before: Snapshot, actorId?: string): string[] {
  const actor = first(nameOf(actorId));
  const lines: string[] = [];

  const added = state.cart.filter((i) => !before.cartIds.includes(i.id));
  for (const i of added) {
    const forWhom = i.memberId === actorId ? "" : ` for ${first(nameOf(i.memberId))}`;
    lines.push(`📥 ${actor} added ${cartLabel(i.id)}${forWhom} to the family cart.`);
  }
  const removed = before.cartIds.filter((id) => !state.cart.some((i) => i.id === id) && !added.length);
  for (const id of removed) lines.push(`🗑️ ${actor} took ${before.cartLabels[id] ?? "an item"} out of the cart.`);

  if (state.exhibits.length > before.exhibits) {
    for (const e of state.exhibits.slice(before.exhibits)) {
      if (!e.private) lines.push(`🗂️ ${actor} filed evidence about ${first(nameOf(e.memberId))}'s phone: ${e.finding}.`);
    }
  }

  if (state.trialRuns > before.trialRuns && state.trial) {
    const t = state.trial;
    const stamps = t.rulings
      .filter((r) => r.memberId)
      .map((r) => `${first(nameOf(r.memberId))}: ${r.stamp}${r.stamp === "WAIT" ? ` till day ${r.holdUntilDay}` : ""}`)
      .join(", ");
    const url = process.env.PUBLIC_URL ?? "http://localhost:3000";
    lines.push(`⚖️ ${actor} asked the court to rule. ${stamps}. Spend today ${usd(t.before)} → ${usd(t.now)}. Case file: ${url}/cart`);
  }

  if (state.nest && state.nest !== before.nest) {
    const n = state.nest;
    lines.push(`🏠 Ruling for ${first(nameOf(n.memberId))}: ${n.stamp}${n.stamp === "STAY" ? ` on the family plan (saves ${usd(n.monthlySavings * 12)}/yr)` : " for a solo plan"}.`);
  }
  return lines;
}

/**
 * Tell everyone except the person who caused it. Goes out on the same channel the change came from:
 * real iPhones over Photon, or the simulator's 1:1 tabs.
 */
export async function broadcastChanges(before: Snapshot, actorId: string | undefined, sourceSpaceId: string) {
  const lines = describeChanges(before, actorId);
  if (!lines.length) return;
  const text = lines.join("\n");
  const others = world.household.members.filter((m) => m.id !== actorId);

  if (sourceSpaceId.startsWith("photon:")) {
    if (!photonReady()) return;
    await Promise.all(
      others.flatMap((m) =>
        m.handles.map((h) => sendToHandle(h, text).catch((e) => console.warn(`[feed] couldn't update ${m.name}:`, (e as Error).message))),
      ),
    );
  } else if (sourceSpaceId.startsWith("sim:dm:")) {
    await Promise.all(others.map((m) => sendTo(`sim:dm:${m.id}`, text, true)));
  }
  console.log(`[feed] told ${others.length} others: ${lines[0].slice(0, 80)}`);
}
