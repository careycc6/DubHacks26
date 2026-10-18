// Family feed: on Photon's free plan everyone talks to the court in their own 1:1 chat, so when one
// person changes the shared cart (or the court rules), everyone else gets a one-line update.
// It feels like a group chat without needing one. Private things (DM notes, budget talk) never go out.
import { usd, VERDICT } from "./engine.ts";
import { sendTo } from "./channels/index.ts";
import { photonReady, sendToHandle } from "./channels/photon.ts";
import { logActivity, state, world } from "./store.ts";

export interface Snapshot {
  cartIds: string[];
  trialRuns: number;
  exhibits: number;
  nest?: object;
  cartLabels: Record<string, string>;
  purchases: number;
  owners: Record<string, string>; // purchase id -> member (to notice "this is for Maya")
}

const nameOf = (id?: string) => world.household.members.find((m) => m.id === id)?.name ?? "Someone";
const first = (name: string) => name.split(/\s+/)[0];

function cartLabel(itemId: string): string {
  const i = state.cart.find((x) => x.id === itemId);
  if (!i) return "an item";
  const p = world.catalog.phones.find((x) => x.id === i.phoneId);
  const a = world.catalog.addons.find((x) => x.id === i.addonId);
  const acc = (world.catalog.accessories ?? []).find((x) => x.id === i.accessoryId);
  return p ? `${p.name} ${i.storageGB}GB` : acc?.name ?? a?.name ?? "an add-on";
}

export function snapshot(): Snapshot {
  return {
    cartIds: state.cart.map((i) => i.id),
    trialRuns: state.trialRuns,
    exhibits: state.exhibits.length,
    nest: state.nest,
    cartLabels: Object.fromEntries(state.cart.map((i) => [i.id, cartLabel(i.id)])),
    purchases: state.purchases.length,
    owners: Object.fromEntries(state.purchases.map((p) => [p.id, p.memberId])),
  };
}

/** One short line per thing that changed since `before`, written for the people who weren't there. */
export function describeChanges(before: Snapshot, actorId?: string): string[] {
  const actor = actorId ? first(nameOf(actorId)) : "The family";
  const lines: string[] = [];

  // A parent moved a purchase to someone else: one line, not the cart shuffling it caused.
  const moved = state.purchases.filter((p) => before.owners?.[p.id] && before.owners[p.id] !== p.memberId);
  if (moved.length) {
    return moved.map((p) => `🧾 ${actor} confirmed the ${p.label} is ${first(nameOf(p.memberId))}'s, not ${first(nameOf(before.owners[p.id]))}'s.`);
  }

  const added = state.cart.filter((i) => !before.cartIds.includes(i.id));
  for (const i of added) {
    const forWhom = i.memberId === actorId ? "" : ` for ${first(nameOf(i.memberId))}`;
    lines.push(`📥 ${actor} added ${cartLabel(i.id)}${forWhom} to the family cart.`);
  }
  // Purchases first: buying something also takes it out of the cart, which needs no separate line.
  const bought = state.purchases.slice(before.purchases);
  for (const p of bought) {
    const save = p.sticker && p.sticker > p.paid ? `, ${usd(p.sticker - p.paid)} under sticker` : "";
    lines.push(`🧾 ${first(nameOf(p.memberId))}'s ${p.label} was bought for ${usd(p.paid)}${save}.`);
  }
  const gone = before.cartIds.filter((id) => !state.cart.some((i) => i.id === id));
  if (gone.length && !state.cart.length && !bought.length && gone.length > 1) {
    lines.push(`🧹 ${actor} cleared the family cart (${gone.length} items). Starting fresh.`);
  } else if (!added.length && !bought.length) {
    for (const id of gone) lines.push(`🗑️ ${actor} took ${before.cartLabels[id] ?? "an item"} out of the cart.`);
  }
  // Edited in place (different phone or storage).
  for (const i of state.cart) {
    const was = before.cartLabels[i.id];
    const now = cartLabel(i.id);
    if (was && was !== now) lines.push(`✏️ ${actor} changed ${was} → ${now}.`);
  }

  if (state.exhibits.length > before.exhibits) {
    for (const e of state.exhibits.slice(before.exhibits)) {
      if (!e.private) lines.push(`🗂️ ${actor} filed evidence about ${first(nameOf(e.memberId))}'s phone: ${e.finding}.`);
    }
  }

  if (state.trialRuns > before.trialRuns && state.trial) {
    const t = state.trial;
    const stamps = t.rulings
      .filter((r) => r.memberId && !r.label.includes("Protection"))
      .map((r) => `${first(nameOf(r.memberId))}: ${VERDICT[r.stamp]?.word ?? r.stamp}${r.stamp === "WAIT" ? ` till day ${r.holdUntilDay}` : ""}`)
      .join(", ");
    const url = process.env.PUBLIC_URL ?? "http://localhost:3000";
    lines.push(`⚖️ ${actorId ? `${actor} asked the court to rule.` : "The court has ruled."} ${stamps}. Spend today ${usd(t.before)} → ${usd(t.now)}, you save ${usd(t.savings)}.${t.budget !== undefined ? ` Phone budget: ${t.overBudget ? "over" : `${usd(t.budget - (t.planned ?? t.now))} left`} after this plan.` : ""} Case file: ${url}/cart`);
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
