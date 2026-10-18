// Tools the agent can call. Every price, date and saving comes from the engine, never from the LLM.
import {
  accessoryType, bestMatch, cartLabel, cartPrice, categories, describePrefs, findAccessory, findCategory, findPhone, handMeDownText, leavingNest,
  memberByTitle, MANAGER_ROLES, missingWords,
  member, mergePrefs, parseLink, parseProductLink, perMonth, phone, phoneBrandFor, pickVariant, PREF_LABELS, priceTrack, productProtection,
  modelLine, promosFor, protectionAdvice, recommend, recommendAccessories, recommendProducts, runTrial, shopLinks, tradeIn, usd,
  type Prefs,
} from "./engine.ts";
import { caseFileUrl } from "./share.ts";
import { changed, currentActor, newId, refreshTrial, remainingBudget, spent, state, trialOpts, world, type Purchase } from "./store.ts";
import type { Accessory, CartItem, Promo, Ruling, Stamp, Trial } from "./types.ts";



// Who runs the cart: parents (and partners). Everyone else's adds wait for a parent's OK.

export function canManage(memberId?: string) {
  if (!memberId) return false;
  const members = world.household.members;
  // A household with no parents (roommates, a couple) runs itself: everyone may manage.
  if (!members.some((m) => MANAGER_ROLES.has(m.role))) return members.some((m) => m.id === memberId);
  return MANAGER_ROLES.has(members.find((m) => m.id === memberId)?.role ?? "");
}

/** Into the cart (one phone per person), or, when a kid asked, into the requests a parent approves. True = it's a request. */
function place(item: CartItem, label: string): boolean {
  const by = currentActor();
  if (by && !canManage(by)) {
    const same = (x: CartItem) => x.memberId === item.memberId && (item.kind === "device" ? x.kind === "device" : cartLabel(world, x) === cartLabel(world, item));
    state.requests = [...(state.requests ?? []).filter((r) => !same(r.item)), { id: newId("r"), item: { ...item, addedBy: by }, label, requestedBy: by, at: Date.now() }];
    changed();
    return true;
  }
  put(item);
  return false;
}
function put(item: CartItem) {
  if (item.kind === "device") state.cart = state.cart.filter((i) => !(i.kind === "device" && i.memberId === item.memberId));
  state.cart.push(item);
  refreshTrial();
  changed();
}

const unique = <T,>(xs: T[]) => (xs.length === 1 ? xs[0] : undefined);

function resolveMember(nameOrId: string) {
  const q = String(nameOrId).toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/\s+/g, " ").trim();
  const all = world.household.members;
  const words = (x: (typeof all)[number]) => x.name.toLowerCase().split(/\s+/);
  // Exact id / full name / role, then "dad" / "mom" / "grandma", then a first or last name ("kairui", "cheng"),
  // then a name that starts with it.
  const m =
    all.find((x) => x.id === q || x.name.toLowerCase() === q || x.role === q) ??
    memberByTitle(world, q) ??
    unique(all.filter((x) => words(x).includes(q) || q.split(" ").every((w) => words(x).includes(w)))) ??
    unique(all.filter((x) => q.length >= 2 && x.name.toLowerCase().startsWith(q)));
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
  const mo = (n: number) => (r.memberId && n > 0 ? ` · ≈${usd(perMonth(n))}/mo` : "");
  const ti = r.tradeIn ? ` with trade-in (${usd(r.tradeIn.withoutTradeIn)} without)` : "";
  switch (r.stamp) {
    case "KEEP":
    case "SWAP":
      return `✅ BUY: ${who}${r.memberId ? item : r.label.split(" · ").slice(1).join(" · ")}${swapped} · ${usd(r.nowCost)} today${ti}${mo(r.nowCost)}${save}${shield}`;
    case "WAIT": {
      const days = (r.holdUntilDay ?? day) - day;
      return `⏳ WAIT ${days} day${days === 1 ? "" : "s"}: ${who}${item}${swapped} · ${usd(r.heldCost)} on day ${r.holdUntilDay}${ti}${mo(r.heldCost)}${save}${shield}`;
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
    : t.overBudget ? [`💰 Budget: this plan (${usd(planned)} now + later) is ${usd(planned - t.budget)} over what's left (${usd(t.budget)})`]
    : [`💰 Budget: this plan uses ${usd(planned)} (now + later), leaving ${usd(t.budget - planned)}`];
  return [
    "⚖️ THE COURT RULES",
    ...t.rulings.map((r) => rulingLine(r, t.day, t.rulings.some((x) => x.memberId === r.memberId && x.label.includes("Protection")))),
    `Spend today: ${usd(t.before)} → ${usd(t.now)} · You save ${usd(t.savings)}`,
    ...budget,
    // Someone is told to wait or to pick a different phone: show them the no-typing way to push back.
    ...(t.rulings.some((r) => r.proposed && r.stamp !== "KEEP" && !r.overruled) ? ["Disagree? Tap 👎 on this to appeal, or ❓ to ask why."] : []),
    `Case file: ${caseFileUrl()}`,
  ].join("\n");
}

const promoLine = (p: Promo) => `${p.name}: ${p.percentOff ? `${p.percentOff}% off` : `−${usd(p.credit ?? 0)}`} (days ${p.startsOnDay}-${p.endsOnDay})`;
/** "What do we pay a month?": each ruled phone over 24 payments, plus the add-ons the court kept. */
export function formatMonthly() {
  const rulings = state.trial?.rulings ?? [];
  if (!rulings.length) return `💵 Nothing's ruled yet, so there's no monthly number. Say "court, rule" and the court will do the math.`;
  const lines: string[] = [];
  let total = 0;
  for (const r of rulings) {
    if (r.stamp === "CUT") continue;
    const price = r.stamp === "WAIT" ? r.heldCost : r.nowCost;
    if (r.memberId && price > 0) {
      total += perMonth(price);
      lines.push(`• ${firstName(r.label)}'s ${r.proposed?.label ?? r.label.split(" · ").slice(1).join(" · ")}: ≈${usd(perMonth(price))}/mo${r.stamp === "WAIT" ? ` from day ${r.holdUntilDay}` : ""}`);
    }
  }
  const cut = rulings.filter((r) => r.stamp === "CUT").reduce((s, r) => s + r.savings, 0);
  return [
    `💵 New phones, about ${usd(total)}/mo together (24 payments, after trade-ins and deals):`,
    ...lines,
    ...(cut > 0 ? [`Skipping the add-ons the court cut takes ≈${usd(Math.round(cut / 12))}/mo off the bill.`] : []),
  ].join("\n");
}

/** "Who gets my old phone?": a hand-me-down to a family member, a trade-in, or keep it. */
export function formatOldPhone(asker?: string) {
  if (!asker) return `📱 Text from your own phone and the court will tell you what happens to it.`;
  const m = member(world, asker);
  const first = m.name.split(/\s+/)[0];
  const rulings = state.trial?.rulings ?? [];
  const mine = rulings.find((r) => r.memberId === asker && r.stamp !== "CUT");
  if (!mine) return `📱 Your ${m.device.model} stays with you: nothing's ruled for ${first} yet.`;
  const passed = rulings.find((r) => r.handMeDown?.from === asker && r.handMeDown.saves > 0);
  if (passed) return `📱 ${handMeDownText(world, passed)}.`;
  if (mine.tradeIn) {
    const when = mine.stamp === "WAIT" ? `on day ${mine.holdUntilDay}` : "today";
    return `📱 Trade it in ${when}: your ${mine.tradeIn.device} is worth ${usd(mine.tradeIn.value)}, already counted in the ${usd(mine.tradeIn.withTradeIn)} price (${usd(mine.tradeIn.withoutTradeIn)} if you keep it as a backup).`;
  }
  return `📱 Keep your ${m.device.model}: it's worth nothing as a trade-in, so it makes a good backup.`;
}

/** "What's in the cart?": every item with where it stands, so nobody has to open the case file to check. */
export function formatStatus(asker?: string) {
  const sticker = (i: (typeof state.cart)[number]) =>
    i.kind === "device" ? phone(world, i.phoneId!).prices[String(i.storageGB)] ?? 0
    : i.kind === "accessory" ? (world.catalog.accessories ?? []).find((a) => a.id === i.accessoryId)?.price ?? 0
    : 0;
  const perMonth = (i: (typeof state.cart)[number]) => i.kind === "addon" ? world.catalog.addons.find((a) => a.id === i.addonId)?.monthly : undefined;
  const ruling = (id: string) => state.trial?.rulings.find((r) => r.itemId === id);
  const unruled = state.cart.filter((i) => !ruling(i.id));
  const lines = state.cart.map((i) => {
    const r = ruling(i.id);
    const price = perMonth(i) !== undefined ? `${usd(perMonth(i)!)}/mo` : usd(sticker(i));
    const mine = i.memberId === asker ? " (yours)" : "";
    const where =
      !r ? "not ruled yet"
      : r.stamp === "WAIT" ? `⏳ wait till day ${r.holdUntilDay}${r.proposed && !r.label.endsWith(r.proposed.label) ? `, the ${r.proposed.label}` : ""}: ${usd(r.heldCost)}`
      : r.stamp === "KEEP" || r.stamp === "SWAP" ? `✅ buy${r.proposed && !r.label.endsWith(r.proposed.label) ? ` the ${r.proposed.label}` : ""}: ${usd(r.nowCost)}`
      : r.stamp === "CUT" ? "✂️ skip" : r.stamp;
    return `• ${cartItemLabel(i)}${mine}, ${price} · ${where}`;
  });
  const total = state.cart.reduce((s, i) => s + sticker(i), 0);
  const bought = state.purchases.slice(-3).map((p) => `${member(world, p.memberId).name.split(/\s+/)[0]}'s ${p.label} (${usd(p.paid)})`);
  return [
    state.cart.length ? `🛒 Family cart, day ${state.day}: ${state.cart.length} item${state.cart.length === 1 ? "" : "s"}, sticker ${usd(total)}` : "🛒 The family cart is empty.",
    ...lines,
    ...(bought.length ? [`🧾 Bought: ${bought.join(", ")}`] : []),
    ...(state.requests?.length ? [`📨 Waiting on a parent's OK: ${state.requests.map((r) => r.label).join(" · ")}. A parent texts "approve" or "deny".`] : []),
    !state.cart.length ? "Paste a store link or ask \"what phone should I get?\" to start."
    : unruled.length ? `When everyone's in, say "court, rule".`
    : `Case file: ${caseFileUrl()}`,
  ].join("\n");
}

export const tools = {
  get_household: {
    description: "Who is on the plan, their current phones (age, battery health, storage used, payments left, trade-in value), other things they already own (TV, laptop, vacuum…), account add-ons, the product categories the store carries, and today's demo day.",
    params: {},
    run: () => ({
      day: state.day,
      household: world.household.name,
      members: world.household.members.map((m) => ({ id: m.id, name: m.name, role: m.role, age: m.age, usage: m.usage, device: m.device })),
      owned: world.household.owned ?? [],
      accountAddons: world.household.accountAddons,
      categories: Object.entries(categories(world)).map(([id, c]) => `${id} (${c.label})`),
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
      model: { type: "string", description: "a model line they named, e.g. 'iphone 18' or 'pixel 10 pro'" },
      budget: { type: "number", description: "max price in USD, if they gave one" },
    },
    required: ["member"],
    run: (a: { member: string; wants?: string[]; brand?: Prefs["brand"]; model?: string; budget?: number }) => {
      const m = resolveMember(a.member);
      const said: Prefs = {};
      for (const w of a.wants ?? []) if (w in PREF_LABELS) (said as Record<string, boolean>)[w] = true;
      if (a.brand) said.brand = a.brand;
      if (a.budget) said.budget = a.budget;
      const prefs = (state.prefs[m.id] = mergePrefs(state.prefs[m.id], said));
      const recs = recommend(world, m.id, { prefs, model: a.model });
      // Other ideas from other lines and brands (say "add the fourth one"): the best of each brand not already picked.
      const seen = new Set(recs.map((r) => r.phoneId));
      const others = recommend(world, m.id, { prefs: { ...prefs, brand: undefined }, limit: 99 })
        .filter((r) => !seen.has(r.phoneId))
        .filter((r, i, all) => all.findIndex((x) => phone(world, x.phoneId).brand === phone(world, r.phoneId).brand) === i)
        .slice(0, 3);
      state.lastRecs[m.id] = [...recs, ...others].map((r) => ({ phoneId: r.phoneId, storageGB: r.storageGB }));
      // "iphone 18" when there's no plain iPhone 18: say which models make up that line.
      const line = (a.model ? modelLine(world, a.model) : []).sort((x, y) => Math.min(...Object.values(x.prices)) - Math.min(...Object.values(y.prices)));
      const exact = line.some((p) => p.name.toLowerCase() === a.model!.toLowerCase());
      const ti = tradeIn(m);
      return {
        forWhom: m.name,
        remembered: describePrefs(prefs),
        modelNote: a.model && !exact
          ? line.length ? `There's no plain ${line[0].name.split(" ").slice(0, 2).join(" ")}: the line is ${line.map((p) => p.name).join(" and ")}.` : `The court doesn't carry a "${a.model}".`
          : undefined,
        // What gets traded in, for how much, and where.
        others: others.map((r) => ({ name: r.name, storageGB: r.storageGB, price: r.price })),
        tradeIn: ti.value > 0 ? { device: m.device.model, value: ti.value, where: "T-Mobile (in store or by mail), or the maker's own trade-in" } : undefined,
        picks: recs.map((r) => {
          const track = priceTrack(world, r.phoneId, r.storageGB, state.day, 90, undefined, m);
          return {
            ...r,
            protection: protectionAdvice(m, r.price),
            withTradeIn: ti.value > 0 ? { price: Math.max(0, r.price - ti.value), tradeIn: m.device.model } : undefined,
            stores: (() => { const p = phone(world, r.phoneId); return shopLinks(p.name, [p.brand], { buy: p.buy }); })(),
            carrierDeal: phone(world, r.phoneId).carrierDeal,
            priceDrop: track.lowest.price < track.now ? { price: track.lowest.price, inDays: track.lowest.day - state.day } : undefined,
            promos: promosFor(world, r.phoneId, state.day).map(promoLine),
          };
        }),
      };
    },
  },
  recommend_products: {
    description:
      "Matchmaker for anything that isn't a phone (laptops, TVs, headphones, game consoles, vacuums, kitchen appliances, chairs, mattresses, shoes, jackets…): " +
      "top 3 in a category with prices, upcoming sales and protection advice.",
    params: {
      member: { type: "string", description: "member name or id" },
      category: { type: "string", description: `a category id (${Object.keys(categories(world)).join(", ")}) or what they called it ("laptop", "air fryer")` },
      budget: { type: "number", description: "max price in USD, if they gave one" },
      brand: { type: "string", description: "only if they named a brand" },
      cheap: { type: "boolean", description: "they care most about price" },
      best: { type: "boolean", description: "they want the best, price matters less" },
    },
    required: ["member", "category"],
    run: (a: { member: string; category: string; budget?: number; brand?: string; cheap?: boolean; best?: boolean }) => {
      const m = resolveMember(a.member);
      const category = a.category in categories(world) ? a.category : findCategory(world, a.category);
      if (!category) throw new Error(`The store doesn't carry "${a.category}". Categories: ${Object.keys(categories(world)).join(", ")}. For anything else, add it with add_product_to_cart and the price they gave.`);
      const picks = recommendProducts(world, m.id, category, a);
      state.lastRecs[m.id] = picks.map((r) => ({ productId: r.productId, variant: r.variant }));
      const cat = categories(world)[category];
      return {
        forWhom: m.name,
        category: cat.label,
        picks: picks.map((r) => {
          const track = priceTrack(world, r.productId, r.variant, state.day, 90, undefined, m);
          return {
            ...r,
            protection: cat.fragile ? productProtection(m, r.price) : undefined,
            priceDrop: track.lowest.price < track.now ? { price: track.lowest.price, inDays: track.lowest.day - state.day } : undefined,
            promos: promosFor(world, r.productId, state.day, category).map(promoLine),
          };
        }),
      };
    },
  },
  add_product_to_cart: {
    description:
      "Add anything that isn't a phone to the shared cart: a catalog product (id or loose name like 'macbook air', 'lg oled 65') or, " +
      "if the store doesn't carry it, a custom item with the name and the price the person gave (never guess a price).",
    params: {
      member: { type: "string" },
      product: { type: "string", description: "catalog id or name, or what the item is" },
      variant: { type: "string", description: "size/config if they said one: '65in', '1TB', 'Queen'" },
      quantity: { type: "number", description: "how many (default 1)" },
      price: { type: "number", description: "USD per item; only for items not in the catalog, as the person stated it" },
      category: { type: "string", description: "for custom items: the closest category id, if any" },
      url: { type: "string", description: "for custom items: the store link they pasted, if any" },
      addedBy: { type: "string", description: "who asked" },
    },
    required: ["member", "product"],
    run: (a: { member: string; product: string; variant?: string; quantity?: number; price?: number; category?: string; url?: string; addedBy?: string }) => {
      const m = resolveMember(a.member);
      const products = world.catalog.products ?? [];
      const p = products.find((x) => x.id === a.product) ?? bestMatch(products, a.product)?.item;
      const quantity = Math.max(1, Math.round(a.quantity ?? 1));
      if (p) {
        const variant = a.variant && a.variant in p.prices ? a.variant : pickVariant(p, `${a.variant ?? ""} ${a.product}`);
        const item = { id: newId("c"), kind: "product" as const, memberId: m.id, productId: p.id, variant, quantity, addedBy: a.addedBy };
        const added = `${cartLabel(world, item)} for ${m.name}`;
        return { added, requested: place(item, added), price: cartPrice(world, item), itemId: item.id };
      }
      if (!(a.price && a.price > 0)) {
        throw new Error(`"${a.product}" isn't in the catalog. Ask what it costs, then add it with that price.`);
      }
      const category = a.category && a.category in categories(world) ? a.category : findCategory(world, a.product);
      const item = { id: newId("c"), kind: "product" as const, memberId: m.id, custom: { name: a.product, price: Math.round(a.price), category }, url: /^https?:\/\//.test(a.url ?? "") ? a.url : undefined, quantity, addedBy: a.addedBy };
      const added = `${cartLabel(world, item)} for ${m.name}`;
      return { added, requested: place(item, added), price: cartPrice(world, item), itemId: item.id };
    },
  },
  report_owned_item: {
    description:
      "Someone says something about a thing they already own that isn't their phone: 'the vacuum died', 'my laptop is 6 years old', 'our TV still works fine'. " +
      "Updates what the rulings use (a broken one is replaced now; a working one can wait).",
    params: {
      member: { type: "string", description: "whose it is; omit for something the household shares" },
      category: { type: "string", description: "category id or what it is ('tv', 'laptop', 'vacuum')" },
      name: { type: "string", description: "what it is, e.g. 'old Hoover upright'" },
      ageMonths: { type: "number" },
      broken: { type: "boolean" },
    },
    required: ["category"],
    run: (a: { member?: string; category: string; name?: string; ageMonths?: number; broken?: boolean }) => {
      const m = a.member ? resolveMember(a.member) : undefined;
      const category = a.category in categories(world) ? a.category : findCategory(world, `${a.category} ${a.name ?? ""}`);
      if (!category) throw new Error(`Unknown category "${a.category}"`);
      const owned = (world.household.owned ??= []);
      let o = owned.find((x) => x.category === category && (x.memberId === m?.id || !x.memberId));
      if (!o) owned.push((o = { id: newId("o"), memberId: m?.id, category, name: a.name ?? `old ${categories(world)[category].label}`, ageMonths: a.ageMonths ?? 0 }));
      if (a.name) o.name = a.name;
      if (typeof a.ageMonths === "number" && a.ageMonths >= 0) o.ageMonths = Math.round(a.ageMonths);
      if (typeof a.broken === "boolean") o.broken = a.broken;
      refreshTrial();
      changed();
      const item = state.cart.find((c) => c.kind === "product" && (!m || c.memberId === m.id) &&
        (c.custom?.category ?? world.catalog.products?.find((p) => p.id === c.productId)?.category) === category);
      const ruling = state.trial?.rulings.find((r) => r.itemId === item?.id);
      return {
        owned: o,
        updatedRuling: ruling ? { stamp: ruling.stamp, reasons: ruling.reasons, nowCost: ruling.nowCost } : "no trial yet; it will count when the cart goes on trial",
      };
    },
  },
  add_recommended: {
    description: "Add one of the phones, products or accessories just recommended to the cart: 'add the first one' = pick 1.",
    params: { member: { type: "string" }, pick: { type: "number", description: "1-3 for the picks, 4-6 for the other ideas" } },
    required: ["member", "pick"],
    run: (a: { member: string; pick: number }): unknown => {
      const m = resolveMember(a.member);
      const r = state.lastRecs[m.id]?.[Math.max(1, Math.min(6, a.pick)) - 1];
      if (!r) throw new Error(`No recent picks for ${m.name}. Ask the court for a recommendation first.`);
      if ("accessoryId" in r) return callTool("add_accessory_to_cart", { member: m.id, accessory: r.accessoryId });
      if (r.productId) return callTool("add_product_to_cart", { member: m.id, product: r.productId, variant: r.variant, addedBy: m.id });
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
      const added = `${acc.name} for ${m.name}`;
      return { added, requested: place({ id: newId("c"), kind: "accessory", memberId: m.id, accessoryId: acc.id, addedBy: m.id }, added), price: acc.price };
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
      // Never add a guess: "iphone 18" could be the 18 Pro or the Pro Max. Show the options instead.
      if (p.id !== a.phone && missingWords(p, a.phone).length) {
        throw new Error(`No phone called "${a.phone}" (closest: ${p.name}). Don't add a guess: call recommend_phones with model "${a.phone}" and let them pick.`);
      }
      const opts = Object.keys(p.prices).map(Number).sort((x, y) => x - y);
      const gb = a.storageGB && opts.includes(a.storageGB) ? a.storageGB : opts.find((x) => x >= (a.storageGB ?? 0)) ?? opts[0];
      const item = { id: newId("c"), kind: "device" as const, memberId: m.id, phoneId: p.id, storageGB: gb, addedBy: a.addedBy };
      const added = `${p.name} ${gb}GB for ${m.name}`;
      return { added, requested: place(item, added), price: p.prices[String(gb)], itemId: item.id };
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
      const added = `${addon.name} for ${m.name}`;
      return { added, requested: place({ id: newId("c"), kind: "addon", memberId: m.id, addonId: addon.id }, added), monthly: addon.monthly };
    },
  },
  approve_request: {
    description: "A parent OKs what a kid asked for (it goes into the cart). Give whose request, or all: true. With one request waiting, no args needed.",
    params: { member: { type: "string", description: "whose request (optional)" }, all: { type: "boolean" } },
    required: [],
    run: (a: { member?: string; all?: boolean }) => decide(a, true),
  },
  deny_request: {
    description: "A parent says no to what a kid asked for (it never goes in the cart).",
    params: { member: { type: "string", description: "whose request (optional)" }, all: { type: "boolean" } },
    required: [],
    run: (a: { member?: string; all?: boolean }) => decide(a, false),
  },
  add_from_link: {
    description: "Someone pasted a store link. Match it to a catalog phone or product (with its storage/size) and add it to the cart for that member.",
    params: { url: { type: "string" }, member: { type: "string", description: "who it's for (usually the sender)" } },
    required: ["url", "member"],
    run: (a: { url: string; member: string }): unknown => {
      const hit = parseLink(world, a.url);
      if (!hit) throw new Error(`Couldn't match that link to anything in the catalog. Ask what it is and what it costs, then add it with add_product_to_cart`);
      const addedBy = resolveMember(a.member).id;
      if (hit.kind === "product") return callTool("add_product_to_cart", { member: a.member, product: hit.product.id, variant: hit.variant, addedBy });
      return callTool("add_phone_to_cart", { member: a.member, phone: hit.phone.id, storageGB: hit.storageGB, addedBy });
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
    run: (a: { member: string; paid: number; phone?: string; accessory?: string; fromReceipt?: boolean; itemId?: string; storageGB?: number }) => {
      const m = resolveMember(a.member);
      if (!(a.paid > 0) || a.paid > 20_000) throw new Error("That price doesn't look right");
      if (a.accessory || a.itemId) return recordAccessory(m.id, a);
      const inCart = findCartItems({ member: m.id, phone: a.phone }).find((i) => i.kind === "device") ?? findCartItems({ member: m.id }).find((i) => i.kind === "device");
      const named = a.phone ? world.catalog.phones.find((x) => x.id === a.phone) ?? findPhone(world, a.phone) : undefined;
      const ph = named ?? (inCart?.phoneId ? phone(world, inCart.phoneId) : undefined);
      const sameAsCart = inCart && (!ph || ph.id === inCart.phoneId);
      const gb = (ph && a.storageGB && ph.prices[String(a.storageGB)] ? a.storageGB : undefined) ?? (sameAsCart ? inCart.storageGB : undefined) ?? (ph ? Object.keys(ph.prices).map(Number).sort((x, y) => x - y)[0] : undefined);
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
      if (ph && gb) newPhone(m.id, purchase);
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
      const hadPhone = !!p.prevDevice;
      if (hadPhone) oldPhoneBack(p); // the new phone is someone else's: the first person keeps their old one
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
      if (hadPhone) newPhone(m.id, p);
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
      state.cart.map((i) => ({
        itemId: i.id, who: member(world, i.memberId).name, item: i.kind === "accessory" ? cartItemLabel(i) : cartLabel(world, i),
        ...(i.kind === "addon" ? { yearly: cartPrice(world, i) } : { price: cartPrice(world, i) }),
      })),
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
/** A phone bought through the court replaces the one on file: new, 100% battery, nothing owed on it. */
export function newPhone(memberId: string, p: Purchase) {
  const m = resolveMember(memberId);
  const ph = p.phoneId ? world.catalog.phones.find((x) => x.id === p.phoneId) : undefined;
  if (!ph || !p.storageGB) return;
  p.prevDevice = structuredClone(m.device);
  m.device = {
    model: ph.name, ageMonths: 0, storageGB: p.storageGB, storageUsedGB: Math.min(m.device.storageUsedGB, p.storageGB),
    batteryHealth: 100, installmentsLeft: 0, monthlyInstallment: 0,
    tradeInValue: Math.round((p.sticker ?? p.paid) * 0.5), // a new phone trades in for about half what it cost
  };
  (state.devices ??= {})[m.id] = structuredClone(m.device);
}

/** Undo newPhone: the person has their old phone again. */
export function oldPhoneBack(p: Purchase) {
  if (!p.prevDevice) return;
  const m = resolveMember(p.memberId);
  m.device = structuredClone(p.prevDevice);
  if (state.devices) delete state.devices[m.id];
  // An earlier phone bought through the court is still theirs.
  const earlier = state.purchases.filter((x) => x !== p && x.memberId === m.id && x.prevDevice).at(-1);
  if (earlier) (state.devices ??= {})[m.id] = structuredClone(m.device);
  p.prevDevice = undefined;
}

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
    label: acc?.name ?? (inCart ? cartItemLabel(inCart) : undefined) ?? a.accessory ?? "an accessory",
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

/** Approve or deny kids' requests: one named person's, all of them, or the only one waiting. */
function decide(a: { member?: string; all?: boolean }, yes: boolean) {
  const waiting = state.requests ?? [];
  if (!waiting.length) return { error: "No requests are waiting." };
  const who = a.member ? resolveMember(a.member).id : undefined;
  const picked = who ? waiting.filter((r) => r.item.memberId === who || r.requestedBy === who) : a.all || waiting.length === 1 ? waiting : [];
  if (!picked.length) return { error: who ? "Nothing waiting from them." : "More than one request is waiting.", waiting: waiting.map((r) => r.label) };
  state.requests = waiting.filter((r) => !picked.includes(r));
  if (yes) for (const r of picked) put(r.item);
  else changed();
  return { [yes ? "approved" : "denied"]: picked.map((r) => r.label) };
}
