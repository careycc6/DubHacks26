// In-memory app state + a tiny pub/sub so the live cart page and simulator update instantly.
import { EventEmitter } from "node:events";
import { loadWorld } from "./data.ts";
import { runTrial, type TrialOptions } from "./engine.ts";
import type { CartItem, NestRuling, Trial, World } from "./types.ts";

export interface ChatLine {
  id: string;
  spaceId: string;
  from: string; // member id, or "court"
  text: string;
  private: boolean; // DM ("approach the bench") vs group
  image?: string; // data URL (simulator only)
  at: number;
}

export interface State {
  day: number;
  cart: CartItem[];
  trial?: Trial;
  nest?: NestRuling;
  privateNotes: Record<string, string[]>; // memberId -> things said in DMs; never repeated in the group
  chat: ChatLine[];
  groupSpaceId?: string; // where proactive "it's time" messages go
}

export const world: World = loadWorld();
export const bus = new EventEmitter();

const fresh = (): State => ({ day: 0, cart: [], privateNotes: {}, chat: [] });
export let state: State = fresh();

let seq = 0;
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;

export function changed() {
  bus.emit("state", publicState());
}

/** What the cart page is allowed to see: no private notes, no DM lines. */
export function publicState() {
  return {
    day: state.day,
    household: world.household.name,
    courtNumber: process.env.COURT_NUMBER ?? "", // shown on the case file so judges can text in
    members: world.household.members.map((m) => ({ id: m.id, name: m.name, role: m.role, device: m.device.model })),
    cart: state.cart.map((i) => {
      const p = world.catalog.phones.find((x) => x.id === i.phoneId);
      const a = world.catalog.addons.find((x) => x.id === i.addonId);
      return { ...i, label: p ? `${p.name} ${i.storageGB}GB` : a?.name, price: p ? p.prices[String(i.storageGB)] : (a?.monthly ?? 0) * 12 };
    }),
    trial: state.trial,
    nest: state.nest,
  };
}

export function addChat(line: Omit<ChatLine, "id" | "at">) {
  const full = { ...line, id: newId("m"), at: Date.now() };
  state.chat.push(full);
  if (state.chat.length > 500) state.chat.shift();
  bus.emit("chat", full);
  return full;
}

const BUDGET_WORDS = /\b(tight|budget|afford|broke|expensive|money|bills?)\b/i;

/** Private DMs can shape rulings (never revealed): e.g. "money is tight" -> budget mode. */
export function trialOpts(): TrialOptions {
  return { tightBudget: Object.values(state.privateNotes).flat().some((n) => BUDGET_WORDS.test(n)) };
}

export function refreshTrial() {
  if (state.trial) state.trial = runTrial(world, state.cart, state.day, trialOpts());
}

export function reset() {
  state = fresh();
  changed();
}
