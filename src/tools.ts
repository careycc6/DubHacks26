// Tools the agent can call. Every price, date and saving comes from the engine, never from the LLM.
import {
  describePrefs, findPhone, leavingNest, member, mergePrefs, parseProductLink, phone, PREF_LABELS, promosFor, recommend, runTrial, usd,
  priceTrack, protectionAdvice,
  type Prefs,
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

const firstName = (label: string) => label.split(" · ")[0].split(/\s+/)[0];

/** One plain line per ruling: what to do, what it costs, what it saves. */
function rulingLine(r: Ruling, day: number, hasProtection = false) {
  const who = r.memberId ? `${firstName(r.label)} · ` : "";
  const item = r.proposed?.label ?? r.label.split(" · ").slice(1).join(" · ");
  const was = r.label.split(" · ").slice(1).join(" · ");
  const swapped = r.proposed && !r.label.endsWith(r.proposed.label) ? ` (instead of ${was})` : "";
  const save = r.savings > 0 ? ` · saves ${usd(r.savings)}` : "";
  const shield = r.protection?.verdict === "ADD" && !hasProtection ? " · 🛡️ add protection" : "";
  switch (r.stamp) {
    case "KEEP":
    case "SWAP":
      return `✅ BUY: ${who}${r.memberId ? item : r.label.split(" · ").slice(1).join(" · ")}${swapped} · ${usd(r.nowCost)} today${save}${shield}`;
    case "WAIT": {
      const days = (r.holdUntilDay ?? day) - day;
      return `⏳ WAIT ${days} day${days === 1 ? "" : "s"}: ${who}${item}${swapped} · ${usd(r.heldCost)} on day ${r.holdUntilDay}${save}${shield}`;
    }
    case "CUT":
      return `✂️ SKIP: ${r.label.split(" · ").slice(1).join(" · ") || r.label}${save ? `${save}/yr` : ""}`;
    default:
      return `${STAMP_ICON[r.stamp]} ${r.stamp}: ${r.label}`;
  }
}

export function formatVerdict(t: Trial) {
  const budget =
    t.budget === undefined ? []
    : t.overBudget ? [`💰 Budget ${usd(t.budget)}: still ${usd(t.now - t.budget)} over (everything left is a phone that can't wait)`]
    : [`💰 Budget ${usd(t.budget)}: ${usd(t.budget - t.now)} left`];
  return [
    "⚖️ THE COURT RULES",
    ...t.rulings.map((r) => rulingLine(r, t.day, t.rulings.some((x) => x.memberId === r.memberId && x.label.includes("Protection")))),
    `Spend today: ${usd(t.before)} → ${usd(t.now)} · You save ${usd(t.savings)}`,
    ...budget,
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
    description:
      "Matchmaker: top 3 phones for a member, based on how they use their phone AND what they said they care about. " +
      "Pass `wants` whenever they mention battery life, screen size, camera, gaming, simplicity or price; it's remembered for next time.",
    params: {
      member: { type: "string", description: "member name or id" },
      wants: {
        type: "array",
        items: { type: "string", enum: ["battery", "bigScreen", "smallScreen", "camera", "gaming", "simple", "cheap"] },
        description: "what they said matters to them",
      },
      brand: { type: "string", enum: ["Apple", "Google", "Samsung"], description: "only if they named a brand" },
      budget: { type: "number", description: "max price in USD, if they gave one" },
    },
    required: ["member"],
    run: (a: { member: string; wants?: string[]; brand?: Prefs["brand"]; budget?: number }) => {
      const m = resolveMember(a.member);
      const said: Prefs = {};
      for (const w of a.wants ?? []) if (w in PREF_LABELS) (said as Record<string, boolean>)[w] = true;
      if (a.brand) said.brand = a.brand;
      if (a.budget) said.budget = a.budget;
      const prefs = (state.prefs[m.id] = mergePrefs(state.prefs[m.id], said));
      const recs = recommend(world, m.id, { prefs });
      state.lastRecs[m.id] = recs.map((r) => ({ phoneId: r.phoneId, storageGB: r.storageGB }));
      return {
        forWhom: m.name,
        remembered: describePrefs(prefs),
        picks: recs.map((r) => {
          const track = priceTrack(world, r.phoneId, r.storageGB, state.day, 90);
          return {
            ...r,
            protection: protectionAdvice(m, r.price),
            priceDrop: track.lowest.price < track.now ? { price: track.lowest.price, inDays: track.lowest.day - state.day } : undefined,
            promos: promosFor(world, r.phoneId, state.day).map((p) => `${p.name}: −${usd(p.credit)} (days ${p.startsOnDay}-${p.endsOnDay})`),
          };
        }),
      };
    },
  },
  add_recommended: {
    description: "Add one of the phones just recommended to the cart: 'add the first one' = pick 1.",
    params: { member: { type: "string" }, pick: { type: "number", description: "1, 2 or 3" } },
    required: ["member", "pick"],
    run: (a: { member: string; pick: number }): unknown => {
      const m = resolveMember(a.member);
      const r = state.lastRecs[m.id]?.[Math.max(1, Math.min(3, a.pick)) - 1];
      if (!r) throw new Error(`No recent picks for ${m.name}. Ask the court for a recommendation first.`);
      return callTool("add_phone_to_cart", { member: m.id, phone: r.phoneId, storageGB: r.storageGB, addedBy: m.id });
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
  add_from_link: {
    description: "Someone pasted a store link. Parse it into a catalog phone + storage and add it to the cart for that member.",
    params: { url: { type: "string" }, member: { type: "string", description: "who the phone is for (usually the sender)" } },
    required: ["url", "member"],
    run: (a: { url: string; member: string }): unknown => {
      const hit = parseProductLink(world, a.url);
      if (!hit) throw new Error(`Couldn't match that link to a phone in the catalog`);
      return callTool("add_phone_to_cart", { member: a.member, phone: hit.phone.id, storageGB: hit.storageGB, addedBy: resolveMember(a.member).id });
    },
  },
  enter_evidence: {
    description: "File a photo or claim as evidence about someone's CURRENT phone (e.g. a battery-health screenshot or a cracked screen). Updates the data the rulings use. Only pass what the evidence actually shows.",
    params: {
      member: { type: "string", description: "whose phone the evidence is about" },
      batteryHealth: { type: "number", description: "battery health % if visible" },
      screenCracked: { type: "boolean", description: "true if the screen is visibly cracked" },
      finding: { type: "string", description: "one short line: what the evidence shows" },
    },
    required: ["member", "finding"],
    run: (a: { member: string; batteryHealth?: number; screenCracked?: boolean; finding: string }) => {
      const m = resolveMember(a.member);
      if (typeof a.batteryHealth === "number" && a.batteryHealth > 0 && a.batteryHealth <= 100) m.device.batteryHealth = Math.round(a.batteryHealth);
      if (a.screenCracked) m.device.screenCracked = true;
      const img = state.pendingImage;
      state.pendingImage = undefined;
      state.exhibits.push({ id: newId("x"), memberId: m.id, finding: a.finding, image: img?.dataUrl, private: img?.private ?? false, at: Date.now() });
      refreshTrial();
      changed();
      const ruling = state.trial?.rulings.find((r) => r.memberId === m.id);
      return {
        exhibit: `Exhibit ${String.fromCharCode(64 + state.exhibits.length)}`,
        device: m.device,
        updatedRuling: ruling ? { stamp: ruling.stamp, reasons: ruling.reasons, nowCost: ruling.nowCost } : "no trial yet; it will count when the cart goes on trial",
      };
    },
  },
  set_budget: {
    description: "Set the FAMILY's budget for this round of shopping (what can be spent today), e.g. 'our budget is $1500'. A personal limit ('under $600 for me') goes to recommend_phones instead.",
    params: { amount: { type: "number", description: "USD; 0 clears it" } },
    required: ["amount"],
    run: (a: { amount: number }) => {
      state.budget = a.amount > 0 ? Math.round(a.amount) : undefined;
      refreshTrial();
      changed();
      const t = state.trial;
      return { budget: state.budget ?? "none", spendToday: t?.now, overBudget: t?.overBudget ?? false };
    },
  },
  add_protection: {
    description: "Add Device Protection for someone's new phone (use when the court advised it, or they ask).",
    params: { member: { type: "string" } },
    required: ["member"],
    run: (a: { member: string }): unknown => {
      const m = resolveMember(a.member);
      if (state.cart.some((i) => i.kind === "addon" && i.addonId === "protection-360" && i.memberId === m.id)) return { added: `Device Protection for ${m.name} (already in the cart)` };
      return callTool("add_addon_to_cart", { member: m.id, addon: "protection-360" });
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
      state.trialRuns++;
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

export function callTool(name: string, args: Record<string, unknown>): unknown {
  const t = (tools as Record<string, { run: (a: any) => unknown }>)[name];
  if (!t) return { error: `Unknown tool ${name}` };
  try {
    return t.run(args ?? {});
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export { resolveMember, caseFileUrl, STAMP_ICON };
