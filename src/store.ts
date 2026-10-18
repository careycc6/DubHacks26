// App state + a tiny pub/sub so the live cart page and simulator update instantly.
// The state is saved through db.ts on every change, so a restart or redeploy picks up where the court left off.
import { EventEmitter } from "node:events";
import { loadWorld } from "./data.ts";
import { get, onShutdown, put } from "./db.ts";
import { runTrial, type Prefs, type TrialOptions } from "./engine.ts";
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

export interface Exhibit {
  id: string;
  memberId: string;
  finding: string; // what the court concluded from it, e.g. "Battery health 76%"
  image?: string; // data URL
  private: boolean; // sent in a DM: shapes rulings, never shown on the case file
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
  exhibits: Exhibit[];
  activity: { at: number; day: number; text: string }[]; // public one-liners for the dashboard
  prefs: Record<string, Prefs>; // what each person said they care about (battery, screen, camera…)
  lastRecs: Record<string, { phoneId: string; storageGB: number }[]>; // so "add the first one" works
  budget?: number; // the family's budget for this round of shopping
  trialRuns: number; // bumps each time the court actually rules (for the family feed)
  pendingImage?: { dataUrl: string; private: boolean }; // latest photo, attached when the court files it as evidence
}

export const world: World = loadWorld();
export const bus = new EventEmitter();

const fresh = (): State => ({ day: 0, cart: [], privateNotes: {}, chat: [], exhibits: [], activity: [], prefs: {}, lastRecs: {}, trialRuns: 0 });

// What gets saved: the state minus photos still waiting to be filed, plus what evidence revealed about each phone.
type Saved = Omit<State, "pendingImage"> & { evidence?: Record<string, { batteryHealth: number; screenCracked?: boolean }> };

function restore(): State {
  const saved = get<Saved | undefined>("state", undefined);
  if (!saved) return fresh();
  const { evidence = {}, ...rest } = saved;
  for (const m of world.household.members) Object.assign(m.device, evidence[m.id] ?? {});
  return { ...fresh(), ...rest };
}
export let state: State = restore();

let lastSaved = "";
function persist() {
  const { pendingImage: _p, ...rest } = state;
  const saved: Saved = {
    ...rest,
    chat: rest.chat.map(({ image: _i, ...line }) => line), // simulator photos are big and only matter live
    evidence: Object.fromEntries(world.household.members.map((m) => [m.id, { batteryHealth: m.device.batteryHealth, screenCracked: m.device.screenCracked }])),
  };
  let json = JSON.stringify(saved);
  if (json.length > 12_000_000) {
    saved.exhibits = saved.exhibits.map(({ image: _i, ...e }) => e); // stay well under MongoDB's 16 MB document limit
    json = JSON.stringify(saved);
  }
  if (json === lastSaved) return;
  lastSaved = json;
  put("state", saved);
}
// Most changes go through changed()/addChat(); this catches the rest (prefs, private notes).
setInterval(persist, 2000).unref();
onShutdown(persist);

let seq = 0;
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;

export function changed() {
  persist();
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
    budget: state.budget,
    exhibits: state.exhibits.filter((e) => !e.private).map(({ private: _p, ...e }) => e),
    activity: state.activity.slice(-40),
  };
}

export function addChat(line: Omit<ChatLine, "id" | "at">) {
  const full = { ...line, id: newId("m"), at: Date.now() };
  state.chat.push(full);
  if (state.chat.length > 500) state.chat.shift();
  bus.emit("chat", full);
  persist();
  return full;
}

const BUDGET_WORDS = /\b(tight|budget|afford|broke|expensive|money|bills?)\b/i;

/** Private DMs can shape rulings (never revealed): e.g. "money is tight" -> budget mode. */
export function trialOpts(): TrialOptions {
  return { tightBudget: Object.values(state.privateNotes).flat().some((n) => BUDGET_WORDS.test(n)), prefs: state.prefs, budget: state.budget };
}

/** Add public one-liners to the dashboard activity log (never private DM content). */
export function logActivity(lines: string[]) {
  for (const text of lines) state.activity.push({ at: Date.now(), day: state.day, text });
  if (state.activity.length > 200) state.activity.splice(0, state.activity.length - 200);
  if (lines.length) changed();
}

export function refreshTrial() {
  if (state.trial) state.trial = runTrial(world, state.cart, state.day, trialOpts());
}

export function reset() {
  Object.assign(world, loadWorld()); // evidence edits device data; restore the pristine household
  state = fresh();
  changed();
}
