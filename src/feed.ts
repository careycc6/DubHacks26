// Family feed: on Photon's free plan everyone talks to the court in their own 1:1 chat, so when one
// person changes the shared cart (or the court rules), everyone else gets a one-line update.
// It feels like a group chat without needing one. Private things (DM notes, budget talk) never go out.
import { cartLabel as engineCartLabel, usd, VERDICT } from "./engine.ts";
import { sendTo } from "./channels/index.ts";
import { photonReady, sendToHandle } from "./channels/photon.ts";
import { logActivity, state, world } from "./store.ts";

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
  return engineCartLabel(world, i);
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
  const actor = actorId ? first(nameOf(actorId)) : "The family";
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
      if (!e.private) lines.push(`🗂️ ${actor} filed evidence for ${first(nameOf(e.memberId))}: ${e.finding}.`);
    }
  }

  if (state.trialRuns > before.trialRuns && state.trial) {
    const t = state.trial;
    const stamps = t.rulings
      .filter((r) => r.memberId && !r.label.includes("Protection"))
      .map((r) => `${first(nameOf(r.memberId))}: ${VERDICT[r.stamp]?.word ?? r.stamp}${r.stamp === "WAIT" ? ` till day ${r.holdUntilDay}` : ""}`)
      .join(", ");
    const url = process.env.PUBLIC_URL ?? "http://localhost:3000";
    lines.push(`⚖️ ${actorId ? `${actor} asked the court to rule.` : "The court has ruled."} ${stamps}. Spend today ${usd(t.before)} → ${usd(t.now)}, you save ${usd(t.savings)}.${t.budget !== undefined ? ` Budget ${usd(t.budget)}: ${t.overBudget ? "still over" : `${usd(t.budget - t.now)} left`}.` : ""} Case file: ${url}/cart`);
  }

  if (state.nest && state.nest !== before.nest) {
    const n = state.nest;
    lines.push(`🏠 Ruling for ${first(nameOf(n.memberId))}: ${n.stamp}${n.stamp === "STAY" ? ` on the family plan (saves ${usd(n.monthlySavings * 12)}/yr)` : " for a solo plan"}.`);
  }
  return lines;
}

/** Send one update to everyone except `exceptId`, on real phones (Photon) or the simulator's 1:1 tabs. */
export async function deliver(text: string, exceptId: string | undefined, channel: "photon" | "sim") {
  const others = world.household.members.filter((m) => m.id !== exceptId);
  if (channel === "photon") {
    if (!photonReady()) return 0;
    const sends = others.flatMap((m) =>
      m.handles.map((h) => sendToHandle(h, text).then(() => 1, (e) => (console.warn(`[feed] couldn't update ${m.name}:`, (e as Error).message), 0))),
    );
    return (await Promise.all(sends)).reduce((a: number, b) => a + b, 0);
  }
  await Promise.all(others.map((m) => sendTo(`sim:dm:${m.id}`, text, true)));
  return others.length;
}

/**
 * Log what changed to the dashboard, and, if it happened in someone's 1:1 chat, tell everyone else
 * on the same channel it came from.
 */
export async function broadcastChanges(before: Snapshot, actorId: string | undefined, sourceSpaceId: string) {
  const lines = describeChanges(before, actorId);
  if (!lines.length) return;
  logActivity(lines);
  const channel = sourceSpaceId.startsWith("photon:") ? "photon" : sourceSpaceId.startsWith("sim:dm:") ? "sim" : undefined;
  if (!channel) return; // a real group chat already saw it
  const n = await deliver(lines.join("\n"), actorId, channel);
  console.log(`[feed] told ${n} others: ${lines[0].slice(0, 80)}`);
}
