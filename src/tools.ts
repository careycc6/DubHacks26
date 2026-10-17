// Tools the agent can call. Every price, date and saving comes from the engine, never from the LLM.
import {
  findPhone, leavingNest, member, phone, promosFor, recommend, runTrial, usd,
} from "./engine.ts";
import { changed, newId, refreshTrial, state, trialOpts, world } from "./store.ts";
import type { Ruling, Stamp, Trial } from "./types.ts";

const caseFileUrl = () => `${process.env.PUBLIC_URL ?? "http://localhost:3000"}/cart`;

function resolveMember(nameOrId: string) {
  const q = String(nameOrId).toLowerCase().trim();
  const m = world.household.members.find(
    (x) => x.id === q || x.name.toLowerCase() === q || x.role === q || (q === "dad" && x.id === "marco") || (q === "mom" && x.id === "elena") || (q === "grandma" && x.role === "grandparent"),
  );
  if (!m) throw new Error(`No household member "${nameOrId}". Members: ${world.household.members.map((x) => x.name).join(", ")}`);
  return m;
}

const STAMP_ICON: Record<Stamp, string> = { KEEP: "✅", SWAP: "🔁", WAIT: "⏳", CUT: "✂️", STAY: "🏠", LEAVE: "🚪" };

function rulingLine(r: Ruling) {
  const extra =
    r.stamp === "WAIT" ? ` until day ${r.holdUntilDay}${r.proposed && !r.label.endsWith(r.proposed.label) ? ` (as ${r.proposed.label})` : ""}`
    : r.stamp === "SWAP" ? ` → ${r.proposed?.label}`
    : "";
  return `${STAMP_ICON[r.stamp]} ${r.stamp}${extra}: ${r.label}. ${r.reasons[0] ?? ""}${r.savings > 0 ? ` (saves ${usd(r.savings)})` : ""}`;
}

export function formatVerdict(t: Trial) {
  return [
    "⚖️ CART COURT IS IN SESSION",
    ...t.rulings.map(rulingLine),
    `Spend today: ${usd(t.before)} → ${usd(t.now)}${t.held ? ` (+${usd(t.held)} held for the right moment)` : ""}`,
    `Case file: ${caseFileUrl()}`,
  ].join("\n");
}

export const tools = {
  get_household: {
    description: "Who is on the plan, their current phones (age, battery health, storage used, payments left, trade-in value), account add-ons, and today's demo day.",
    params: {},
    run: () => ({
      day: state.day,
      household: world.household.name,
      members: world.household.members.map((m) => ({ id: m.id, name: m.name, role: m.role, age: m.age, usage: m.usage, device: m.device })),
      accountAddons: world.household.accountAddons,
    }),
  },
  recommend_phones: {
    description: "Matchmaker: top 3 phones for a member based on how they actually use their phone, with the right storage size and price.",
    params: { member: { type: "string", description: "member name or id" }, budget: { type: "number", description: "optional max price in USD" } },
    required: ["member"],
    run: (a: { member: string; budget?: number }) => {
      const m = resolveMember(a.member);
      return recommend(world, m.id, { budget: a.budget }).map((r) => ({ ...r, promos: promosFor(world, r.phoneId, state.day).map((p) => `${p.name}: −${usd(p.credit)} (days ${p.startsOnDay}-${p.endsOnDay})`) }));
    },
  },
  add_phone_to_cart: {
    description: "Add a phone to the shared family cart for a member. Accepts a catalog id or a loose name like '17 pro max'.",
    params: { member: { type: "string" }, phone: { type: "string" }, storageGB: { type: "number", description: "optional storage; defaults to the smallest option" }, addedBy: { type: "string", description: "who asked" } },
    required: ["member", "phone"],
    run: (a: { member: string; phone: string; storageGB?: number; addedBy?: string }) => {
      const m = resolveMember(a.member);
      const p = world.catalog.phones.find((x) => x.id === a.phone) ?? findPhone(world, a.phone);
      if (!p) throw new Error(`No phone matching "${a.phone}". Catalog: ${world.catalog.phones.map((x) => x.name).join(", ")}`);
      const opts = Object.keys(p.prices).map(Number).sort((x, y) => x - y);
      const gb = a.storageGB && opts.includes(a.storageGB) ? a.storageGB : opts.find((x) => x >= (a.storageGB ?? 0)) ?? opts[0];
      state.cart = state.cart.filter((i) => !(i.kind === "device" && i.memberId === m.id)); // one phone per person
      const item = { id: newId("c"), kind: "device" as const, memberId: m.id, phoneId: p.id, storageGB: gb, addedBy: a.addedBy };
      state.cart.push(item);
      refreshTrial();
      changed();
      return { added: `${p.name} ${gb}GB for ${m.name}`, price: p.prices[String(gb)], itemId: item.id };
    },
  },
  add_addon_to_cart: {
    description: "Add an add-on (device protection, hotspot, international pass) to the cart for a member.",
    params: { member: { type: "string" }, addon: { type: "string", description: `one of: ${world.catalog.addons.map((a) => a.id).join(", ")}` } },
    required: ["member", "addon"],
    run: (a: { member: string; addon: string }) => {
      const m = resolveMember(a.member);
      const addon = world.catalog.addons.find((x) => x.id === a.addon || x.name.toLowerCase().includes(a.addon.toLowerCase()));
      if (!addon) throw new Error(`Unknown add-on "${a.addon}"`);
      state.cart.push({ id: newId("c"), kind: "addon", memberId: m.id, addonId: addon.id });
      refreshTrial();
      changed();
      return { added: `${addon.name} for ${m.name}`, monthly: addon.monthly };
    },
  },
  remove_from_cart: {
    description: "Remove a cart item by id.",
    params: { itemId: { type: "string" } },
    required: ["itemId"],
    run: (a: { itemId: string }) => {
      state.cart = state.cart.filter((i) => i.id !== a.itemId);
      refreshTrial();
      changed();
      return { cart: state.cart };
    },
  },
  view_cart: {
    description: "The current shared cart with sticker prices.",
    params: {},
    run: () =>
      state.cart.map((i) => i.kind === "device"
        ? { itemId: i.id, who: member(world, i.memberId).name, item: `${phone(world, i.phoneId!).name} ${i.storageGB}GB`, price: phone(world, i.phoneId!).prices[String(i.storageGB)] }
        : { itemId: i.id, who: member(world, i.memberId).name, item: i.addonId }),
  },
  run_trial: {
    description: "Put the cart on trial before checkout. Returns rulings (KEEP/SWAP/WAIT/CUT) with exact numbers plus a ready-to-send verdict text. Use whenever someone wants to check out, asks 'should we buy', or asks the court to rule.",
    params: {},
    run: () => {
      state.trial = runTrial(world, state.cart, state.day, trialOpts());
      changed();
      return { verdictText: formatVerdict(state.trial), trial: state.trial };
    },
  },
  leaving_nest: {
    description: "Someone is moving out or leaving for college: should they STAY on the family plan or LEAVE for a solo plan? Exact monthly numbers.",
    params: { member: { type: "string" } },
    required: ["member"],
    run: (a: { member: string }) => {
      state.nest = leavingNest(world, resolveMember(a.member).id);
      changed();
      return state.nest;
    },
  },
} satisfies Record<string, { description: string; params: Record<string, unknown>; required?: string[]; run: (a: any) => unknown }>;

export type ToolName = keyof typeof tools;

export function callTool(name: string, args: Record<string, unknown>) {
  const t = (tools as Record<string, { run: (a: any) => unknown }>)[name];
  if (!t) return { error: `Unknown tool ${name}` };
  try {
    return t.run(args ?? {});
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export { resolveMember, caseFileUrl, STAMP_ICON };
