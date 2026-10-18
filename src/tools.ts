// Tools the agent can call. Every price, date and saving comes from the engine, never from the LLM.
import {
  describePrefs, findPhone, leavingNest, member, mergePrefs, parseProductLink, phone, PREF_LABELS, promosFor, recommend, runTrial, usd,
  priceTrack, protectionAdvice, recommendAccessories, findAccessory, phoneBrandFor, accessoryType,
  type Prefs,
} from "./engine.ts";
import { changed, newId, refreshTrial, remainingBudget, spent, state, trialOpts, world, type Purchase } from "./store.ts";
import type { Accessory, Ruling, Stamp, Trial } from "./types.ts";

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
  // Both prices, so keeping the old phone (hand-me-down, backup) is an informed choice.
  const ti = r.tradeIn ? ` with trade-in (${usd(r.tradeIn.withoutTradeIn)} without)` : "";
  switch (r.stamp) {
    case "KEEP":
    case "SWAP":
      return `✅ BUY: ${who}${r.memberId ? item : r.label.split(" · ").slice(1).join(" · ")}${swapped} · ${usd(r.nowCost)} today${ti}${save}${shield}`;
    case "WAIT": {
      const days = (r.holdUntilDay ?? day) - day;
      return `⏳ WAIT ${days} day${days === 1 ? "" : "s"}: ${who}${item}${swapped} · ${usd(r.heldCost)} on day ${r.holdUntilDay}${ti}${save}${shield}`;
    }
    case "CUT":
      return `✂️ SKIP: ${r.label.split(" · ").slice(1).join(" · ") || r.label}${save ? `${save}/yr` : ""}`;
    default:
      return `${STAMP_ICON[r.stamp]} ${r.stamp}: ${r.label}`;
  }
}

export function formatVerdict(t: Trial) {
  // Family phone budget = the whole plan (now and later), minus what's already been bought.
  const planned = t.planned ?? t.now + t.held;
  const budget =
    t.budget === undefined ? []
    : t.overBudget ? [`💰 Phone budget: this plan (${usd(planned)} now + later) is ${usd(planned - t.budget)} over what's left (${usd(t.budget)})`]
    : [`💰 Phone budget: this plan uses ${usd(planned)} (now + later), leaving ${usd(t.budget - planned)}`];
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
            withTradeIn: m.device.tradeInValue > 0 ? { price: Math.max(0, r.price - m.device.tradeInValue), tradeIn: m.device.model } : undefined,
            priceDrop: track.lowest.price < track.now ? { price: track.lowest.price, inDays: track.lowest.day - state.day } : undefined,
            promos: promosFor(world, r.phoneId, state.day).map((p) => `${p.name}: −${usd(p.credit)} (days ${p.startsOnDay}-${p.endsOnDay})`),
          };
        }),
      };
    },
  },
  add_recommended: {
    description: "Add one of the phones or accessories just recommended to the cart: 'add the first one' = pick 1.",
    params: { member: { type: "string" }, pick: { type: "number", description: "1, 2 or 3" } },
    required: ["member", "pick"],
    run: (a: { member: string; pick: number }): unknown => {
      const m = resolveMember(a.member);
      const r = state.lastRecs[m.id]?.[Math.max(1, Math.min(3, a.pick)) - 1];
      if (!r) throw new Error(`No recent picks for ${m.name}. Ask the court for a recommendation first.`);
      if ("accessoryId" in r) return callTool("add_accessory_to_cart", { member: m.id, accessory: r.accessoryId });
      return callTool("add_phone_to_cart", { member: m.id, phone: r.phoneId, storageGB: r.storageGB, addedBy: m.id });
    },
  },
  recommend_accessories: {
    description: "Accessories that fit someone's phone (the one in the cart, else their current one): a case, screen protector, charger, power bank or earbuds. Leave type empty for the essentials.",
    params: {
      member: { type: "string" },
      type: { type: "string", enum: ["case", "screen", "charger", "battery", "earbuds"], description: "optional" },
    },
    required: ["member"],
    run: (a: { member: string; type?: Accessory["type"] }) => {
      const m = resolveMember(a.member);
      const picks = recommendAccessories(world, m.id, { type: a.type, cart: state.cart });
      state.lastRecs[m.id] = picks.map((p) => ({ accessoryId: p.accessoryId }));
      return { forWhom: m.name, phoneBrand: phoneBrandFor(world, m.id, state.cart), picks };
    },
  },
  add_accessory_to_cart: {
    description: "Add an accessory (case, screen protector, charger, power bank, earbuds) to the cart for someone. Accepts an id or a loose name like 'rugged case'.",
    params: { member: { type: "string" }, accessory: { type: "string" } },
    required: ["member", "accessory"],
    run: (a: { member: string; accessory: string }) => {
      const m = resolveMember(a.member);
      const acc = (world.catalog.accessories ?? []).find((x) => x.id === a.accessory) ?? findAccessory(world, a.accessory);
      if (!acc) throw new Error(`No accessory matching "${a.accessory}"`);
      state.cart.push({ id: newId("c"), kind: "accessory", memberId: m.id, accessoryId: acc.id, addedBy: m.id });
      refreshTrial();
      changed();
      return { added: `${acc.name} for ${m.name}`, price: acc.price };
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
    description: "Set the FAMILY's phone budget: the money set aside for phones over the whole plan (now and later, can span years), e.g. 'our budget is $3000'. A personal limit ('under $600 for me') goes to recommend_phones instead.",
    params: { amount: { type: "number", description: "USD; 0 clears it" } },
    required: ["amount"],
    run: (a: { amount: number }) => {
      state.budget = a.amount > 0 ? Math.round(a.amount) : undefined;
      refreshTrial();
      changed();
      const t = state.trial;
      return { budget: state.budget ?? "none", spent: spent(), planned: t?.planned, left: t?.planned !== undefined && t.budget !== undefined ? t.budget - t.planned : remainingBudget(), overBudget: t?.overBudget ?? false };
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
    description: "Remove items from the family cart: someone's phone and/or add-ons. Give the member, or a phone name, or an itemId.",
    params: {
      member: { type: "string", description: "whose items (optional)" },
      phone: { type: "string", description: "loose phone name to match (optional)" },
      itemId: { type: "string", description: "exact cart item id (optional)" },
      addonsToo: { type: "boolean", description: "also remove that member's add-ons (default false)" },
    },
    run: (a: { member?: string; phone?: string; itemId?: string; addonsToo?: boolean }) => {
      if (!a.member && !a.phone && !a.itemId) throw new Error("Say whose item or which phone to remove (or clear the whole cart)");
      const hits = findCartItems(a);
      if (!hits.length) throw new Error("Nothing in the cart matches that");
      const removed = hits.map(cartItemLabel);
      state.cart = state.cart.filter((i) => !hits.includes(i));
      if (!state.cart.length) state.trial = undefined; // nothing left to rule on
      refreshTrial();
      changed();
      return { removed, left: state.cart.length };
    },
  },
  clear_cart: {
    description: "Empty the whole family cart to start over (purchases already recorded are kept).",
    params: {},
    run: () => {
      const n = state.cart.length;
      state.cart = [];
      state.trial = undefined;
      changed();
      return { cleared: n };
    },
  },
  change_cart_item: {
    description: "Edit a phone already in the cart: different storage and/or a different phone. Identify it by member (or phone name).",
    params: {
      member: { type: "string" },
      phone: { type: "string", description: "current phone to match (optional)" },
      newPhone: { type: "string", description: "swap to this phone (optional)" },
      storageGB: { type: "number", description: "new storage size (optional)" },
    },
    run: (a: { member?: string; phone?: string; newPhone?: string; storageGB?: number }) => {
      const item = findCartItems({ member: a.member, phone: a.phone }).find((i) => i.kind === "device");
      if (!item) throw new Error("No phone in the cart for that");
      const next = a.newPhone ? world.catalog.phones.find((x) => x.id === a.newPhone) ?? findPhone(world, a.newPhone) : phone(world, item.phoneId!);
      if (!next) throw new Error(`No phone matching "${a.newPhone}"`);
      const opts = Object.keys(next.prices).map(Number).sort((x, y) => x - y);
      const want = a.storageGB ?? item.storageGB ?? opts[0];
      const gb = opts.includes(want) ? want : opts.find((x) => x >= want) ?? opts[opts.length - 1];
      const before = cartItemLabel(item);
      item.phoneId = next.id;
      item.storageGB = gb;
      refreshTrial();
      changed();
      return { from: before, to: `${next.name} ${gb}GB`, price: next.prices[String(gb)], storageNote: gb !== want ? `${want}GB isn't offered; used ${gb}GB` : undefined };
    },
  },
  record_purchase: {
    description:
      "Someone actually bought a phone or an accessory (they said so, or sent a receipt / order confirmation). Records what they paid, takes it out of the cart, and tells the family how it compares. Only use a price that the person or the receipt actually states.",
    params: {
      member: { type: "string", description: "who it was for" },
      paid: { type: "number", description: "total paid in USD" },
      phone: { type: "string", description: "what they bought, if stated (defaults to their cart phone)" },
      accessory: { type: "string", description: "set instead of phone when they bought an accessory: its name or type (case, charger…)" },
      fromReceipt: { type: "boolean", description: "true if read from a receipt / order confirmation" },
    },
    required: ["member", "paid"],
    run: (a: { member: string; paid: number; phone?: string; accessory?: string; fromReceipt?: boolean; itemId?: string }) => {
      const m = resolveMember(a.member);
      if (!(a.paid > 0) || a.paid > 20_000) throw new Error("That price doesn't look right");
      if (a.accessory || a.itemId) return recordAccessory(m.id, a);
      const inCart = findCartItems({ member: m.id, phone: a.phone }).find((i) => i.kind === "device") ?? findCartItems({ member: m.id }).find((i) => i.kind === "device");
      const named = a.phone ? world.catalog.phones.find((x) => x.id === a.phone) ?? findPhone(world, a.phone) : undefined;
      const ph = named ?? (inCart?.phoneId ? phone(world, inCart.phoneId) : undefined);
      const gb = inCart?.storageGB ?? (ph ? Object.keys(ph.prices).map(Number).sort((x, y) => x - y)[0] : undefined);
      const ruling = inCart ? state.trial?.rulings.find((r) => r.itemId === inCart.id) : undefined;
      const purchase: Purchase = {
        id: newId("p"),
        memberId: m.id,
        label: ph ? `${ph.name} ${gb}GB` : a.phone ?? "a phone",
        phoneId: ph?.id,
        storageGB: gb,
        paid: Math.round(a.paid),
        sticker: ph && gb ? ph.prices[String(gb)] : undefined,
        courtPrice: ruling ? (ruling.stamp === "WAIT" ? ruling.heldCost : ruling.nowCost) : undefined,
        day: state.day,
        at: Date.now(),
        source: a.fromReceipt ? "receipt" : "text",
      };
      state.purchases.push(purchase);
      // Bought: the phone (and its add-ons like protection) leave the cart.
      if (inCart) {
        const gone = (i: (typeof state.cart)[number]) => i.memberId === m.id && (i.id === inCart.id || i.kind === "addon");
        purchase.fromCart = state.cart.filter(gone); // so "this is for Maya" can put them back
        state.cart = state.cart.filter((i) => !gone(i));
      }
      if (!state.cart.length) state.trial = undefined;
      refreshTrial();
      changed();
      return {
        recorded: `${m.name}: ${purchase.label} for ${usd(purchase.paid)}`, forWhom: m.name, label: purchase.label, isPhone: !purchase.accessoryId,
        savedVsSticker: purchase.sticker ? purchase.sticker - purchase.paid : undefined,
        vsCourtPrice: purchase.courtPrice !== undefined ? purchase.paid - purchase.courtPrice : undefined,
        spentSoFar: spent(),
        budgetLeft: remainingBudget(),
      };
    },
  },
  reassign_purchase: {
    description:
      "A parent says the purchase just logged was really for someone else (\"this is for Maya\"). Moves the most recent purchase (or purchaseId) to that member: their matching cart phone leaves the cart and anything removed by mistake goes back.",
    params: {
      member: { type: "string", description: "who it was really for" },
      purchaseId: { type: "string", description: "optional; defaults to the most recent purchase" },
    },
    required: ["member"],
    run: (a: { member: string; purchaseId?: string }) => {
      const m = resolveMember(a.member);
      const p = a.purchaseId ? state.purchases.find((x) => x.id === a.purchaseId) : state.purchases.at(-1);
      if (!p) throw new Error("There's no purchase to move yet");
      if (p.memberId === m.id) return { recorded: `${m.name}: ${p.label}`, unchanged: true };
      const was = resolveMember(p.memberId).name;
      // Undo what the first logging took out of the wrong person's cart…
      if (p.fromCart?.length) state.cart.push(...p.fromCart.filter((i) => !state.cart.some((c) => c.id === i.id)));
      // …and take the new owner's matching item out instead.
      const theirs = state.cart.filter((i) => i.memberId === m.id);
      const match = p.accessoryId
        ? theirs.find((i) => i.accessoryId === p.accessoryId)
        : theirs.find((i) => i.kind === "device" && i.phoneId === p.phoneId) ?? theirs.find((i) => i.kind === "device");
      const gone = (i: (typeof state.cart)[number]) => !!match && i.memberId === m.id && (i.id === match.id || (!p.accessoryId && i.kind === "addon"));
      p.fromCart = state.cart.filter(gone);
      state.cart = state.cart.filter((i) => !gone(i));
      p.memberId = m.id;
      const ruling = match ? state.trial?.rulings.find((r) => r.itemId === match.id) : undefined;
      p.courtPrice = ruling ? (ruling.stamp === "WAIT" ? ruling.heldCost : ruling.nowCost) : undefined;
      if (!state.cart.length) state.trial = undefined;
      refreshTrial();
      changed();
      return { recorded: `${m.name}: ${p.label} for ${usd(p.paid)}`, movedFrom: was, tookFromCart: match ? cartItemLabel(match) : undefined };
    },
  },
  view_cart: {
    description: "The current shared cart with sticker prices.",
    params: {},
    run: () =>
      state.cart.map((i) => i.kind === "device"
        ? { itemId: i.id, who: member(world, i.memberId).name, item: `${phone(world, i.phoneId!).name} ${i.storageGB}GB`, price: phone(world, i.phoneId!).prices[String(i.storageGB)] }
        : { itemId: i.id, who: member(world, i.memberId).name, item: cartItemLabel(i) }),
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

export { resolveMember, caseFileUrl, STAMP_ICON, findCartItems };

/** An accessory was bought (by text, or with the dashboard's Bought… button). */
function recordAccessory(memberId: string, a: { paid: number; accessory?: string; fromReceipt?: boolean; itemId?: string }) {
  const m = resolveMember(memberId);
  const accs = world.catalog.accessories ?? [];
  const mine = state.cart.filter((i) => i.kind === "accessory" && i.memberId === m.id);
  const type = a.accessory ? accessoryType(a.accessory) : undefined;
  const named = a.accessory ? accs.find((x) => x.id === a.accessory) ?? findAccessory(world, a.accessory) : undefined;
  const inCart = a.itemId
    ? state.cart.find((i) => i.id === a.itemId)
    : mine.find((i) => i.accessoryId === named?.id) ?? mine.find((i) => accs.find((x) => x.id === i.accessoryId)?.type === type);
  const acc = accs.find((x) => x.id === inCart?.accessoryId) ?? named;
  const ruling = inCart ? state.trial?.rulings.find((r) => r.itemId === inCart.id) : undefined;
  const purchase: Purchase = {
    id: newId("p"),
    memberId: m.id,
    label: acc?.name ?? a.accessory ?? "an accessory",
    accessoryId: acc?.id,
    paid: Math.round(a.paid * 100) / 100,
    sticker: acc?.price,
    courtPrice: ruling ? (ruling.stamp === "WAIT" ? ruling.heldCost : ruling.nowCost) : undefined,
    day: state.day,
    at: Date.now(),
    source: a.fromReceipt ? "receipt" : "text",
  };
  state.purchases.push(purchase);
  if (inCart) {
    purchase.fromCart = [inCart];
    state.cart = state.cart.filter((i) => i.id !== inCart.id);
  }
  if (!state.cart.length) state.trial = undefined;
  refreshTrial();
  changed();
  return {
    recorded: `${m.name}: ${purchase.label} for ${usd(purchase.paid)}`, forWhom: m.name, label: purchase.label, isPhone: false,
    savedVsSticker: purchase.sticker ? purchase.sticker - purchase.paid : undefined,
    spentSoFar: spent(),
    budgetLeft: remainingBudget(),
  };
}

/** Cart items matching a member and/or a loose phone name (or an exact id). */
function findCartItems(q: { member?: string; phone?: string; itemId?: string; addonsToo?: boolean }) {
  if (q.itemId) return state.cart.filter((i) => i.id === q.itemId);
  const m = q.member ? resolveMember(q.member) : undefined;
  const p = q.phone ? world.catalog.phones.find((x) => x.id === q.phone) ?? findPhone(world, q.phone) : undefined;
  return state.cart.filter((i) => {
    if (m && i.memberId !== m.id) return false;
    if (p) return i.kind === "device" && i.phoneId === p.id;
    return i.kind === "device" || !!q.addonsToo || !m;
  });
}

function cartItemLabel(i: { kind: string; memberId: string; phoneId?: string; storageGB?: number; addonId?: string; accessoryId?: string }) {
  const who = member(world, i.memberId).name.split(/\s+/)[0];
  if (i.kind === "device" && i.phoneId) return `${who}'s ${phone(world, i.phoneId).name} ${i.storageGB}GB`;
  if (i.kind === "accessory") return `${who}'s ${(world.catalog.accessories ?? []).find((a) => a.id === i.accessoryId)?.name ?? "accessory"}`;
  return `${who}'s ${world.catalog.addons.find((a) => a.id === i.addonId)?.name ?? "add-on"}`;
}
