// App state + a tiny pub/sub so the live cart page and simulator update instantly.
// The state is saved through db.ts on every change, so a restart or redeploy picks up where the court left off.
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { loadWorld } from "./data.ts";
import { get, onReload, onShutdown, put } from "./db.ts";
import { cartLabel, cartLinks, cartPrice, managers, runTrial, type Prefs, type TrialOptions } from "./engine.ts";
import type { CartItem, Member, NestRuling, Owned, Trial, World } from "./types.ts";
import type { AppealRecord } from "./appeal.ts";

export interface ChatLine {
  id: string;
  spaceId: string;
  from: string; // member id, or "court"
  text: string;
  private: boolean; // DM ("approach the bench") vs group
  image?: string; // data URL (simulator only)
  effect?: "slam" | "confetti"; // iMessage send effect (the simulator animates it too)
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

/** A kid asked for something: it waits here until a parent texts "approve" (or "deny"). */
export interface CartRequest {
  id: string;
  item: CartItem;
  label: string; // "iPhone 17 256GB for Jaret"
  requestedBy: string;
  at: number;
}

/** Who sent the message being handled (none: the dashboard or a script, which act as a parent). */
export const actor = new AsyncLocalStorage<{ memberId?: string }>();
export const currentActor = () => actor.getStore()?.memberId;

/** Something the family actually bought (from a text, a receipt photo, or the dashboard). */
export interface Purchase {
  id: string;
  memberId: string;
  label: string; // "iPhone 17 Pro 256GB"
  phoneId?: string;
  storageGB?: number;
  accessoryId?: string;
  paid: number;
  sticker?: number; // the store price of what they'd put in the cart
  courtPrice?: number; // what the court said it should cost (after trade-in / promos), if it had ruled
  day: number;
  at: number;
  source: "text" | "receipt" | "dashboard";
  fromCart?: CartItem[]; // what left the cart when it was logged (restored if it was for someone else)
  prevDevice?: Member["device"]; // the phone they had before this one (put back if the purchase is undone or moved)
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
  lastRecs: Record<string, ({ phoneId?: string; storageGB?: number; productId?: string; variant?: string } | { accessoryId: string })[]>; // so "add the first one" works
  budget?: number; // the family's budget for this round of shopping
  seenIds: string[]; // Photon message ids already handled (delivery is at-least-once)
  purchases: Purchase[];
  trialRuns: number; // bumps each time the court actually rules (for the family feed)
  pendingClear?: Record<string, number>; // memberId -> when their "cart clear" confirmation expires (ms)
  // memberId -> a purchase waiting on a receipt photo (or a receipt waiting on its total)
  pendingReceipt?: Record<string, { until: number; seen?: boolean; paid?: number; phoneId?: string; accessory?: string; owner?: string }>;
  // memberId -> a store link the court couldn't read, waiting on what it is and what it costs
  pendingLink?: Record<string, { url: string; forWhom: string; until: number; name?: string; price?: number }>;
  pendingImage?: { dataUrl: string; private: boolean }; // latest photo, attached when the court files it as evidence
  appeals?: AppealRecord[]; // appeals, overrules and reinstatements, oldest first (public: they're about rulings)
  pendingAppeal?: Record<string, { until: number; about: string }>; // memberId -> the court asked "tell me why"
  requests?: CartRequest[]; // kids' adds waiting on a parent
  devices?: Record<string, Member["device"]>; // memberId -> the phone they bought through the court (replaces the one on file)
  usage?: Record<string, { camera: number; gaming: number }>; // memberId -> how they said they use a phone (1-5)
  pendingUsage?: Record<string, { forWhom: string; until: number }>; // sender -> the court asked how someone uses a phone
}

export const world: World = loadWorld();
export const bus = new EventEmitter();

const fresh = (): State => ({ day: 0, cart: [], privateNotes: {}, chat: [], exhibits: [], activity: [], prefs: {}, lastRecs: {}, seenIds: [], purchases: [], trialRuns: 0 });

// What gets saved: the state minus photos still waiting to be filed, plus what evidence revealed about each phone
// and what people said about the things they already own ("the vacuum died").
type Saved = Omit<State, "pendingImage"> & { evidence?: Record<string, { batteryHealth: number; screenCracked?: boolean }>; owned?: Owned[] };

export type Snapshot = Saved;

function fromSaved(saved: Saved | undefined): State {
  if (!saved) return fresh();
  const { evidence = {}, owned, ...rest } = structuredClone(saved);
  for (const m of world.household.members) {
    if (rest.devices?.[m.id]) m.device = structuredClone(rest.devices[m.id]); // a phone bought through the court
    Object.assign(m.device, evidence[m.id] ?? {});
  }
  if (owned) world.household.owned = owned;
  for (const m of world.household.members) Object.assign(m.usage, rest.usage?.[m.id] ?? {}); // what they told the court
  return { ...fresh(), ...rest };
}
export let state: State = fromSaved(get<Saved | undefined>("state", undefined));

/** Everything a restart (or a demo checkpoint) needs to put the court back exactly where it was. */
export function snapshot(): Snapshot {
  const { pendingImage: _p, ...rest } = state;
  const saved: Saved = structuredClone({
    ...rest,
    chat: rest.chat.map(({ image: _i, ...line }) => line), // simulator photos are big and only matter live
    evidence: Object.fromEntries(world.household.members.map((m) => [m.id, { batteryHealth: m.device.batteryHealth, screenCracked: m.device.screenCracked }])),
    owned: world.household.owned,
  });
  if (JSON.stringify(saved).length > 12_000_000) {
    saved.exhibits = saved.exhibits.map(({ image: _i, ...e }) => e); // stay well under MongoDB's 16 MB document limit
  }
  return saved;
}

/** Put the court back at a snapshot. Household setup (names, numbers) is untouched. */
export function restoreSnapshot(snap: Snapshot) {
  Object.assign(world, loadWorld()); // start from the pristine phones, then re-apply that moment's evidence
  state = fromSaved(snap);
  changed();
}

// Another copy of the court (serverless) may have changed things: start from what's saved.
onReload(() => {
  Object.assign(world, loadWorld());
  state = fromSaved(get<Saved | undefined>("state", undefined));
  // What's loaded counts as saved: a request that changes nothing mustn't write it back, or a copy that loaded
  // just before someone else's change (a new budget or price) would overwrite it, and the value flips back and forth.
  lastSaved = JSON.stringify(snapshot());
});

let lastSaved = "";
/** Save now (also called at the end of every serverless request). */
export function persist() {
  const saved = snapshot();
  const json = JSON.stringify(saved);
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
      // Links for what the court said to buy (a swap links the swapped-in phone, not the one argued for).
      const r = state.trial?.rulings.find((x) => x.itemId === i.id);
      const ruled = r?.proposed && (r.proposed.phoneId || r.proposed.productId) ? { ...i, ...r.proposed } : i;
      const links = cartLinks(world, ruled);
      return { ...i, label: cartLabel(world, i), price: cartPrice(world, i), shopUrl: links?.[0]?.url, shopLinks: links, checked: checkedOn(ruled) };
    }),
    trial: state.trial,
    nest: state.nest,
    budget: state.budget,
    purchases: state.purchases,
    spent: spent(),
    exhibits: state.exhibits.filter((e) => !e.private).map(({ private: _p, ...e }) => e),
    activity: state.activity.slice(-40),
    // The latest appeal / overrule per cart item, for the badge on its ruling.
    appeals: Object.values(Object.fromEntries((state.appeals ?? []).map((a) => [a.itemId, a]))),
  };
}

/** The day the catalog price was read off the maker's store (shown on the case file). */
function checkedOn(i: CartItem): string | undefined {
  const c = world.catalog;
  return (c.phones.find((x) => x.id === i.phoneId) ?? (c.accessories ?? []).find((x) => x.id === i.accessoryId) ?? (c.products ?? []).find((x) => x.id === i.productId))?.checked;
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

/** Money already spent this round (recorded purchases). */
export const spent = () => state.purchases.reduce((t, p) => t + p.paid, 0);
/** What's left of the family budget after what's already been bought (undefined = no budget). */
export const remainingBudget = () => (state.budget === undefined ? undefined : Math.max(0, state.budget - spent()));

/** Private DMs can shape rulings (never revealed): e.g. "money is tight" -> budget mode. */
export function trialOpts(): TrialOptions {
  // Only the people paying get to say money is tight: a teen calling a phone "expensive" isn't a budget.
  const payers = new Set(managers(world).map((m) => m.id));
  const anyone = payers.size === 0; // no parents (roommates): everyone pays their share
  const tightBudget = Object.entries(state.privateNotes).some(([id, notes]) => (anyone || payers.has(id)) && notes.some((n) => BUDGET_WORDS.test(n)));
  return { tightBudget, prefs: state.prefs, budget: remainingBudget() };
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
