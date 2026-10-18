// The pricing engine. Deterministic and LLM-free: every number the agent says comes from here.
import type {
  CartItem, Category, Member, NestRuling, Owned, Phone, Product, Promo, Recommendation, Ruling, Trial, World,
} from "./types.ts";

const LOW_BATTERY = 80; // below this, upgrading now is justified
const PROMO_LOOKAHEAD_DAYS = 90;
const DAYS_PER_PAYMENT = 30;
export const SCREEN_REPAIR = 129;

export const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export function member(world: World, id: string): Member {
  const m = world.household.members.find((x) => x.id === id);
  if (!m) throw new Error(`Unknown member "${id}"`);
  return m;
}

export function phone(world: World, id: string): Phone {
  const p = world.catalog.phones.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown phone "${id}"`);
  return p;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Best loose name match in a list, with its score (>= 0.6 counts as a match). */
export function bestMatch<T extends { name: string }>(items: T[], query: string): { item: T; score: number } | undefined {
  const q = norm(query);
  const scored = items
    .map((item) => {
      const name = norm(item.name);
      const words = name.split(" ");
      const hits = words.filter((w) => q.split(" ").includes(w)).length;
      return { item, score: q.includes(name) ? 100 + name.length : hits / words.length };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0] && scored[0].score >= 0.6 ? scored[0] : undefined;
}

/** Loose name match ("17 pro max", "pixel 10") -> catalog phone. */
export function findPhone(world: World, query: string): Phone | undefined {
  return bestMatch(world.catalog.phones, query)?.item;
}

/** Does this promo cover this phone / product (by id, or by its whole category)? */
export const promoCovers = (x: Promo, id: string, category?: string) =>
  !!(x.phones?.includes(id) || x.products?.includes(id) || (category && x.categories?.includes(category)));

/** What a promo takes off this sticker: a flat credit or a percentage. */
export const promoCredit = (x: Promo, sticker: number) => x.credit ?? Math.round((sticker * (x.percentOff ?? 0)) / 100);

/** "−$312" or "20% off (−$300)". */
const promoText = (x: Promo, sticker: number) => (x.percentOff ? `${x.percentOff}% off (−${usd(promoCredit(x, sticker))})` : `−${usd(promoCredit(x, sticker))}`);

const storageOptions = (p: Phone) => Object.keys(p.prices).map(Number).sort((a, b) => a - b);

/** Smallest storage tier with 2x headroom over what the person actually uses. */
export function neededStorage(p: Phone, m: Member): number {
  const opts = storageOptions(p);
  return opts.find((gb) => gb >= m.device.storageUsedGB * 2) ?? opts[opts.length - 1];
}

const promoFor = (world: World, id: string, day: number, category?: string) => ({
  active: world.offers.promos.find((x) => promoCovers(x, id, category) && x.startsOnDay <= day && day < x.endsOnDay),
  upcoming: world.offers.promos.find(
    (x) => promoCovers(x, id, category) && x.startsOnDay > day && x.startsOnDay - day <= PROMO_LOOKAHEAD_DAYS,
  ),
});

function overkill(p: Phone, m: Member, prefs: Prefs = {}) {
  // If they told the court they care about the camera or gaming, the Pro features aren't wasted.
  if (prefs.camera || prefs.gaming) return false;
  return p.tier === "flagship" && m.usage.camera <= 3 && m.usage.gaming <= 2;
}

export interface TrialOptions {
  /** Someone privately told the court money is tight. Shapes rulings; never revealed. */
  tightBudget?: boolean;
  /** What each person said they care about (battery, screen, camera…), by member id. */
  prefs?: Record<string, Prefs>;
  /** The family's budget for this round of shopping (what can be spent today). */
  budget?: number;
}

// ---------------------------------------------------------------- plain-English verdicts

/** What people see: BUY / WAIT / SKIP / STAY instead of the court's internal stamps. */
export const VERDICT: Record<string, { word: string; hint: string }> = {
  KEEP: { word: "BUY", hint: "good to go" },
  SWAP: { word: "BUY", hint: "a better pick" },
  WAIT: { word: "WAIT", hint: "price drops later" },
  CUT: { word: "SKIP", hint: "cancel it" },
  STAY: { word: "STAY", hint: "on the family plan" },
  LEAVE: { word: "GO SOLO", hint: "own plan" },
};

// ---------------------------------------------------------------- price tracker

/** Sticker and category for anything priceable: a phone (variant = storage GB), a product (variant = size), or a custom item. */
function sticker(world: World, id: string, variant: string | number): { price: number; category?: string } {
  const ph = world.catalog.phones.find((x) => x.id === id);
  if (ph) return { price: ph.prices[String(variant)] ?? Math.min(...Object.values(ph.prices)) };
  const pr = product(world, id);
  return { price: pr.prices[String(variant)] ?? Math.min(...Object.values(pr.prices)), category: pr.category };
}

/** Store price on a given demo day (sticker minus any promo running that day). Pass `custom` for items not in the catalog. */
export function priceOn(world: World, id: string, variant: string | number, day: number, custom?: { price: number; category?: string }): number {
  const { price, category } = custom ?? sticker(world, id, variant);
  const promo = world.offers.promos.find((x) => promoCovers(x, id, category) && x.startsOnDay <= day && day < x.endsOnDay);
  return price - (promo ? promoCredit(promo, price) : 0);
}

export interface PriceTrack {
  points: { day: number; price: number }[];
  now: number;
  lowest: { day: number; price: number };
}

/** Price over the next `span` days, with every promo start/end as its own point, so drops show exactly. */
export function priceTrack(
  world: World, id: string, variant: string | number, fromDay: number, span = 120, custom?: { price: number; category?: string },
): PriceTrack {
  const { category } = custom ?? sticker(world, id, variant);
  const days = new Set<number>();
  for (let d = fromDay; d <= fromDay + span; d += 10) days.add(d);
  for (const x of world.offers.promos.filter((x) => promoCovers(x, id, category))) {
    for (const d of [x.startsOnDay - 1, x.startsOnDay, x.endsOnDay - 1, x.endsOnDay]) if (d >= fromDay && d <= fromDay + span) days.add(d);
  }
  const points = [...days].sort((a, b) => a - b).map((day) => ({ day, price: priceOn(world, id, variant, day, custom) }));
  const lowest = points.reduce((best, p) => (p.price < best.price ? p : best), points[0]);
  return { points, now: points[0].price, lowest };
}

// ---------------------------------------------------------------- protection plans

export const PROTECTION_MONTHLY = 18;

/** Is Device Protection worth it for this person and this phone? */
export function protectionAdvice(m: Member, phonePrice: number): { verdict: "ADD" | "SKIP" | "OPTIONAL"; monthly: number; reason: string } {
  const yearly = PROTECTION_MONTHLY * 12;
  const young = m.age < 20 || ["teen", "kid"].includes(m.role);
  if (phonePrice >= 800 && (young || m.device.screenCracked)) {
    return {
      verdict: "ADD",
      monthly: PROTECTION_MONTHLY,
      reason: `${m.device.screenCracked ? "Their current screen is already cracked" : "Teens drop phones"}: ${usd(PROTECTION_MONTHLY)}/mo protects a ${usd(phonePrice)} phone`,
    };
  }
  if (phonePrice < 600) {
    return { verdict: "SKIP", monthly: PROTECTION_MONTHLY, reason: `Skip it: ${usd(yearly)}/yr is a lot next to a ${usd(phonePrice)} phone. A good case does the job` };
  }
  return { verdict: "OPTIONAL", monthly: PROTECTION_MONTHLY, reason: `Optional: ${usd(yearly)}/yr vs a ${usd(SCREEN_REPAIR)} screen repair if it ever breaks` };
}

function witnessStatement(m: Member): string {
  const free = Math.round(100 - (m.device.storageUsedGB / m.device.storageGB) * 100);
  const monthsLeft = Math.max(6, Math.round((m.device.batteryHealth - 70) * 1.2));
  return `I am ${m.name}'s ${m.device.model}. I am ${m.device.ageMonths} months old. My battery is at ${m.device.batteryHealth}% and ${free}% of my storage is still free. I have about ${monthsLeft} good months left. I'd like to be heard before I'm replaced.`;
}

function reviewDevice(world: World, item: CartItem, day: number, opts: TrialOptions = {}): Ruling {
  const m = member(world, item.memberId);
  const picked = phone(world, item.phoneId!);
  const pickedGB = item.storageGB ?? storageOptions(picked)[0];
  const originalCost = picked.prices[String(pickedGB)] ?? picked.prices[String(storageOptions(picked)[0])];
  const reasons: string[] = [];

  // 1. Right phone? Swap flagship -> same-brand mid tier when the Pro features go unused.
  let target = picked;
  if (overkill(picked, m, opts.prefs?.[m.id])) {
    const mid = world.catalog.phones.find((p) => p.brand === picked.brand && p.tier === "mid");
    // Don't downgrade away from what they told the court they want (a big screen, long battery).
    const wants = opts.prefs?.[m.id] ?? {};
    const losesWhatTheyWant = !!mid && ((wants.bigScreen && mid.screenIn < picked.screenIn) || (wants.battery && mid.batteryHours < picked.batteryHours - 1));
    if (mid && !losesWhatTheyWant) {
      target = mid;
      reasons.push(`Pro features ${m.name} won't use (camera ${m.usage.camera}/5, gaming ${m.usage.gaming}/5), so the ${mid.name} is the better fit`);
    }
  }

  // 1b. Budget pressure (from a private DM): if this phone is being bought now anyway, go one tier down
  //     when it still covers how they use a phone. The reason never says who asked.
  if (opts.tightBudget && target === picked && picked.tier === "flagship" && m.device.batteryHealth < LOW_BATTERY) {
    const mid = world.catalog.phones.find((p) => p.brand === picked.brand && p.tier === "mid");
    if (mid && mid.camera >= m.usage.camera && mid.gaming >= m.usage.gaming) {
      target = mid;
      reasons.push(`Keeping this month's total in check: the ${mid.name} has the ${mid.camera}/5 camera ${m.name} actually uses`);
    }
  }

  // 1c. Their own budget ("under $600"): swap to the best pick for them that fits it.
  const myBudget = opts.prefs?.[m.id]?.budget;
  if (myBudget && target.prices[String(neededStorage(target, m))] > myBudget) {
    const fit = recommend(world, m.id, { prefs: opts.prefs?.[m.id] }).find((r) => r.price <= myBudget);
    if (fit) {
      target = phone(world, fit.phoneId);
      reasons.push(`Over ${m.name.split(/\s+/)[0]}'s ${usd(myBudget)} budget: the ${target.name} fits it`);
    }
  }

  // 2. Right storage?
  let gb = target === picked ? pickedGB : Math.min(pickedGB, neededStorage(target, m));
  if (!(String(gb) in target.prices)) gb = neededStorage(target, m);
  const need = neededStorage(target, m);
  if (gb > need) {
    reasons.push(`${gb}GB is overkill: ${m.name} uses ${m.device.storageUsedGB}GB after ${m.device.ageMonths} months, so ${need}GB is plenty`);
    gb = need;
  }
  let price = target.prices[String(gb)];
  const math: { label: string; amount: number }[] = [{ label: `${picked.name} ${pickedGB}GB, as argued`, amount: originalCost }];
  if (price !== originalCost) math.push({ label: target.id !== picked.id ? `Switch to ${target.name} ${gb}GB` : `Drop to ${gb}GB`, amount: price - originalCost });

  // 3. Trade-in the family forgot about.
  if (m.device.tradeInValue > 0) {
    reasons.push(`Trade in ${m.name}'s ${m.device.model}: −${usd(m.device.tradeInValue)}`);
    price -= m.device.tradeInValue;
    math.push({ label: `Trade-in: ${m.device.model}`, amount: -m.device.tradeInValue });
  }

  // 4. Timing: should this purchase wait?
  const { active, upcoming } = promoFor(world, target.id, day);
  if (active) {
    reasons.push(`${active.name} is live: ${promoText(active, target.prices[String(gb)])}`);
    const off = promoCredit(active, target.prices[String(gb)]);
    price -= off;
    math.push({ label: `${active.name} (live now)`, amount: -off });
  }
  const healthy = m.device.batteryHealth >= LOW_BATTERY;
  let holdUntilDay: number | undefined;
  if (healthy && upcoming && !active) {
    holdUntilDay = upcoming.startsOnDay;
    const off = promoCredit(upcoming, target.prices[String(gb)]);
    reasons.push(`${upcoming.name} starts in ${upcoming.startsOnDay - day} days: ${promoText(upcoming, target.prices[String(gb)])}`);
    price -= off;
    math.push({ label: `${upcoming.name} (from day ${upcoming.startsOnDay})`, amount: -off });
  }
  // installmentsLeft is as of day 0; payments keep getting made as the demo clock moves.
  const paymentsLeft = Math.max(0, Math.ceil((m.device.installmentsLeft * DAYS_PER_PAYMENT - day) / DAYS_PER_PAYMENT));
  if (healthy && paymentsLeft > 0) {
    holdUntilDay = Math.max(holdUntilDay ?? 0, m.device.installmentsLeft * DAYS_PER_PAYMENT);
    reasons.push(`${paymentsLeft} payments (${usd(paymentsLeft * m.device.monthlyInstallment)}) left on the ${m.device.model}. Upgrading now means paying it off early`);
  }
  if (holdUntilDay !== undefined) {
    reasons.unshift(`${m.name}'s ${m.device.model} still has ${m.device.batteryHealth}% battery health. It has time left`);
  } else if (!healthy) {
    reasons.unshift(`${m.name}'s ${m.device.model} is at ${m.device.batteryHealth}% battery health. Upgrading now makes sense`);
  }

  // A cracked screen on an otherwise healthy phone is a repair, not a reason to buy a new phone.
  const repairNow = holdUntilDay !== undefined && !!m.device.screenCracked;
  if (repairNow) reasons.splice(1, 0, `Exhibit A shows a cracked screen. A ${usd(SCREEN_REPAIR)} screen repair fixes that today. A new phone doesn't have to`);
  else if (m.device.screenCracked) reasons.splice(1, 0, "Exhibit A shows a cracked screen too");

  const changed = target.id !== picked.id || gb !== pickedGB;
  const stamp = holdUntilDay !== undefined ? "WAIT" : changed ? "SWAP" : "KEEP";
  const waitSavings = holdUntilDay !== undefined ? paymentsLeft * m.device.monthlyInstallment : 0;
  return {
    itemId: item.id,
    memberId: m.id,
    label: `${m.name} · ${picked.name} ${pickedGB}GB`,
    stamp,
    reasons,
    originalCost,
    nowCost: stamp === "WAIT" ? (repairNow ? SCREEN_REPAIR : 0) : price,
    heldCost: stamp === "WAIT" ? price : 0,
    savings: originalCost - price + waitSavings - (repairNow ? SCREEN_REPAIR : 0),
    holdUntilDay,
    proposed: { phoneId: target.id, storageGB: gb, label: `${target.name} ${gb}GB` },
    witness: stamp === "WAIT" ? witnessStatement(m) : undefined,
    witnessOf: stamp === "WAIT" ? `${m.name}'s current phone` : undefined,
    urgent: !healthy || !!m.device.screenCracked,
    math,
    protection: protectionAdvice(m, target.prices[String(gb)]),
    track: priceTrack(world, target.id, gb, day, Math.max(90, (holdUntilDay ?? day) - day + 40)),
  };
}

function reviewAddon(world: World, item: CartItem, cart: CartItem[] = []): Ruling {
  const addon = world.catalog.addons.find((a) => a.id === item.addonId);
  if (!addon) throw new Error(`Unknown add-on "${item.addonId}"`);
  const m = member(world, item.memberId);
  const yearly = addon.monthly * 12;
  // Protection on their new phone: judged on its own merits, not as a duplicate of an old plan.
  const device = cart.find((c) => c.kind === "device" && c.memberId === m.id);
  if (addon.id === "protection-360" && device?.phoneId) {
    const p = phone(world, device.phoneId);
    const advice = protectionAdvice(m, p.prices[String(device.storageGB)] ?? Math.min(...Object.values(p.prices)));
    const keep = advice.verdict !== "SKIP";
    return {
      itemId: item.id, memberId: m.id, label: `${m.name} · ${addon.name}`, stamp: keep ? "KEEP" : "CUT",
      reasons: [advice.reason], originalCost: yearly, nowCost: keep ? yearly : 0, heldCost: 0, savings: keep ? 0 : yearly,
      math: [{ label: `${addon.name}: 12 × ${usd(addon.monthly)}`, amount: yearly }, ...(keep ? [] : [{ label: "Struck: not worth it for this phone", amount: -yearly }])],
    };
  }
  const dupe = world.household.accountAddons.find((a) => a.id === addon.id);
  if (dupe && !dupe.usedInLast12Months) {
    return {
      itemId: item.id, memberId: m.id, label: `${m.name} · ${addon.name}`, stamp: "CUT",
      reasons: [`The account already pays for ${dupe.name} and nobody has used it in 12 months`],
      originalCost: yearly, nowCost: 0, heldCost: 0, savings: yearly,
      math: [{ label: `${addon.name}: 12 × ${usd(addon.monthly)}`, amount: yearly }, { label: "Struck: already on the account, unused", amount: -yearly }],
    };
  }
  return {
    itemId: item.id, memberId: m.id, label: `${m.name} · ${addon.name}`, stamp: "KEEP",
    reasons: ["Reasonable add-on"], originalCost: yearly, nowCost: yearly, heldCost: 0, savings: 0,
    math: [{ label: `${addon.name}: 12 × ${usd(addon.monthly)}`, amount: yearly }],
  };
}

/** Put the whole cart (plus the account's dead weight) on trial. */
export function runTrial(world: World, cart: CartItem[], day: number, opts: TrialOptions = {}): Trial {
  const rulings = cart.map((item) =>
    item.kind === "device" ? reviewDevice(world, item, day, opts)
    : item.kind === "product" ? reviewProduct(world, item, day, opts, cart)
    : reviewAddon(world, item, cart));
  for (const a of world.household.accountAddons) {
    if (a.usedInLast12Months) continue;
    const yearly = a.monthly * 12;
    rulings.push({
      itemId: `account:${a.id}`, label: `Account · ${a.name}`, stamp: "CUT",
      reasons: [`${usd(a.monthly)}/mo and unused for 12 months`],
      originalCost: yearly, nowCost: 0, heldCost: 0, savings: yearly,
      math: [{ label: `${a.name}: 12 × ${usd(a.monthly)}`, amount: yearly }, { label: "Struck: unused for 12 months", amount: -yearly }],
    });
  }
  const sum = (f: (r: Ruling) => number) => rulings.reduce((t, r) => t + f(r), 0);

  // Protection follows its phone: if the phone waits, so does the plan.
  const holdAddonsWithPhones = () => {
    for (const r of rulings) {
      if (r.stamp !== "KEEP" || !r.label.includes("Protection") || !r.memberId) continue;
      const phoneRuling = rulings.find((x) => x.memberId === r.memberId && x.proposed?.phoneId && x.stamp === "WAIT");
      if (!phoneRuling) continue;
      r.stamp = "WAIT";
      r.holdUntilDay = phoneRuling.holdUntilDay;
      r.heldCost = r.nowCost;
      r.nowCost = 0;
      r.reasons.unshift("Starts the day the new phone does");
    }
  };
  holdAddonsWithPhones();

  // Family budget: if today's spend is over it, hold the purchases that can most afford to wait:
  // nice-to-haves first (priciest first), then phones (healthiest current phone first).
  // Anything replacing something broken or failing is never held for budget.
  if (opts.budget !== undefined && sum((r) => r.nowCost) > opts.budget) {
    const products = rulings
      .filter((r) => (r.stamp === "KEEP" || r.stamp === "SWAP") && r.proposed?.productId !== undefined && !r.urgent)
      .sort((a, b) => b.nowCost - a.nowCost);
    const phones = rulings
      .filter((r) => (r.stamp === "KEEP" || r.stamp === "SWAP") && r.memberId && r.proposed?.phoneId)
      .map((r) => ({ r, m: member(world, r.memberId!) }))
      .filter(({ m }) => m.device.batteryHealth >= 75 && !m.device.screenCracked)
      .sort((a, b) => b.m.device.batteryHealth - a.m.device.batteryHealth)
      .map(({ r }) => r);
    for (const r of [...products, ...phones]) {
      if (sum((x) => x.nowCost) <= opts.budget) break;
      r.stamp = "WAIT";
      r.holdUntilDay = day + 30;
      r.heldCost = r.nowCost;
      r.nowCost = 0;
      r.reasons.unshift(`Over the family's ${usd(opts.budget)} budget for now: this one can wait a month`);
    }
  }
  holdAddonsWithPhones(); // a phone held for budget takes its protection plan with it
  const now = sum((r) => r.nowCost);
  return {
    day,
    rulings,
    before: sum((r) => r.originalCost),
    now,
    held: sum((r) => r.heldCost),
    savings: sum((r) => r.savings),
    budget: opts.budget,
    overBudget: opts.budget !== undefined && now > opts.budget,
  };
}

/** Move the clock: rulings already acted on stay locked; only held (WAIT) items get re-judged. */
export function advanceTrial(world: World, cart: CartItem[], old: Trial | undefined, day: number, opts: TrialOptions = {}): Trial | undefined {
  if (!old) return undefined;
  const fresh = runTrial(world, cart, day, opts);
  const rulings = fresh.rulings.map((r) => {
    const prev = old.rulings.find((p) => p.itemId === r.itemId);
    // Bought items stay bought; held items keep their promise until their day comes.
    const stillHeld = prev?.stamp === "WAIT" && (prev.holdUntilDay ?? 0) > day;
    return prev && (prev.stamp !== "WAIT" || stillHeld) ? prev : r;
  });
  const sum = (f: (r: Ruling) => number) => rulings.reduce((t, r) => t + f(r), 0);
  return { day, rulings, before: sum((r) => r.originalCost), now: sum((r) => r.nowCost), held: sum((r) => r.heldCost), savings: sum((r) => r.savings) };
}

/** Held (WAIT) rulings whose moment has arrived by `day`. */
export function readyHolds(trial: Trial | undefined, day: number): Ruling[] {
  // Phones only: a held protection plan just starts alongside its phone, no separate alert.
  return (trial?.rulings ?? []).filter((r) => r.stamp === "WAIT" && !!r.proposed && (r.holdUntilDay ?? Infinity) <= day);
}

/** A kid moving out (or anyone leaving): stay on the family plan or go solo? */
export function leavingNest(world: World, memberId: string): NestRuling {
  const m = member(world, memberId);
  const byLines = world.offers.familyPlan.totalMonthlyByLines;
  const n = world.household.members.length;
  const familyLineMonthly = byLines[String(n)] - byLines[String(n - 1)];
  const solo = [...world.offers.soloPlans]
    .filter((p) => p.dataGB >= m.usage.dataGBPerMonth)
    .sort((a, b) => a.monthly - b.monthly)[0] ?? world.offers.soloPlans[0];
  const stay = familyLineMonthly <= solo.monthly;
  return {
    memberId,
    stamp: stay ? "STAY" : "LEAVE",
    familyLineMonthly,
    soloPlan: { name: solo.name, monthly: solo.monthly },
    monthlySavings: Math.abs(solo.monthly - familyLineMonthly),
    reasons: stay
      ? [
          `${m.name}'s line costs the family ${usd(familyLineMonthly)}/mo. The cheapest solo plan that fits ${m.usage.dataGBPerMonth}GB/mo is ${solo.name} at ${usd(solo.monthly)}/mo`,
          `Staying saves ${usd(solo.monthly - familyLineMonthly)}/mo (${usd((solo.monthly - familyLineMonthly) * 12)}/yr). ${m.name} keeps the same number either way`,
        ]
      : [
          `${solo.name} at ${usd(solo.monthly)}/mo beats the ${usd(familyLineMonthly)}/mo family line. Move ${m.name} to their own plan and keep the number (port it)`,
        ],
  };
}

/** Matchmaker: best phones for how this person actually uses a phone. */
/** What someone said they care about, e.g. "I want long battery life and a bigger screen under $800". */
export interface Prefs {
  battery?: boolean;
  bigScreen?: boolean;
  smallScreen?: boolean;
  camera?: boolean;
  gaming?: boolean;
  simple?: boolean;
  cheap?: boolean;
  budget?: number;
  brand?: "Apple" | "Google" | "Samsung";
}

export const PREF_LABELS: Record<Exclude<keyof Prefs, "budget" | "brand">, string> = {
  battery: "long battery life",
  bigScreen: "a bigger screen",
  smallScreen: "a smaller phone",
  camera: "a great camera",
  gaming: "gaming",
  simple: "something simple",
  cheap: "a lower price",
};

/** Read preferences out of a chat message. Returns {} when nothing was said. */
export function parsePrefs(text: string): Prefs {
  const t = text.toLowerCase();
  const p: Prefs = {};
  if (/\b(battery|lasts? (all|the whole) day|dies|charging|charge)\b/.test(t)) p.battery = true;
  if (/\b(big(ger)?|large(r)?|huge) (screen|display|phone)\b|\bscreen size\b|\bmax\b|\bplus\b|\bultra\b/.test(t)) p.bigScreen = true;
  if (/\b(small(er)?|compact|one[- ]handed|mini|fits? in (my )?pocket) ?(screen|phone)?\b/.test(t)) p.smallScreen = true;
  if (/\b(camera|photos?|pictures?|selfies?|video|zoom)\b/.test(t)) p.camera = true;
  if (/\b(gaming|games?|fortnite|genshin|fps)\b/.test(t)) p.gaming = true;
  if (/\b(simple|easy to use|big buttons|flip phone|for (my )?(grandma|grandpa|mom|dad))\b/.test(t)) p.simple = true;
  // "Our budget is $1500" is the family's budget (see familyBudget), not one person's price limit.
  if (!familyBudget(text)) {
    if (/\b(cheap(er|est)?|affordable|budget|inexpensive|save money|not expensive)\b/.test(t)) p.cheap = true;
    const money = t.match(/(?:under|below|less than|max(?:imum)?|up to|budget(?: is| of)?)\s*\$?\s*(\d{3,4})/) ?? t.match(/\$\s*(\d{3,4})/);
    if (money) p.budget = Number(money[1]);
  }
  if (/\b(iphone|apple|ios)\b/.test(t)) p.brand = "Apple";
  else if (/\b(pixel|google)\b/.test(t)) p.brand = "Google";
  else if (/\b(samsung|galaxy)\b/.test(t)) p.brand = "Samsung";
  if (p.bigScreen && p.smallScreen) delete p.smallScreen;
  return p;
}

export const hasPrefs = (p: Prefs) => Object.keys(p).length > 0;

/** Matchmaker: best phones for how this person uses a phone, plus anything they told the court they want. */
export function recommend(world: World, memberId: string, opts: { budget?: number; prefs?: Prefs } = {}): Recommendation[] {
  const m = member(world, memberId);
  const prefs = opts.prefs ?? {};
  const budget = opts.budget ?? prefs.budget;
  const wantsSimple = prefs.simple || m.age >= 70;
  const needCamera = prefs.camera ? 5 : m.usage.camera;
  const needGaming = prefs.gaming ? 5 : m.usage.gaming;
  const phones = world.catalog.phones;
  const maxBattery = Math.max(...phones.filter((p) => !p.simple).map((p) => p.batteryHours));
  const maxScreen = Math.max(...phones.map((p) => p.screenIn));
  const minScreen = Math.min(...phones.filter((p) => !p.simple).map((p) => p.screenIn));

  return phones
    .filter((p) => !p.simple || wantsSimple) // big-button phones only for people who want simple
    .map((p) => {
      const gb = neededStorage(p, m);
      const price = p.prices[String(gb)];
      const why: string[] = [];
      let score = 100;
      score -= 15 * Math.max(0, needCamera - p.camera);
      score -= 15 * Math.max(0, needGaming - p.gaming);
      score -= 5 * Math.max(0, p.camera - needCamera - 1); // paying for camera you won't use
      score -= price / (prefs.cheap ? 25 : 50);
      if (p.simple) score += wantsSimple ? 40 : -100;
      if (budget && price > budget) score -= 50;

      // Things they said they care about lead the "why".
      if (prefs.battery) {
        score += (Math.min(p.batteryHours, 36) - 28) * 10;
        if (!p.simple && p.batteryHours >= maxBattery - 1) why.push(`${p.batteryHours}h battery, among the longest here`);
        else why.push(`${p.batteryHours}h battery`);
      }
      if (prefs.bigScreen) {
        score += (p.screenIn - 6.3) * 45;
        if (p.screenIn >= maxScreen - 0.05) why.push(`${p.screenIn}" screen, the biggest we carry`);
        else if (p.screenIn >= 6.5) why.push(`${p.screenIn}" big screen`);
      }
      if (prefs.smallScreen && !p.simple) {
        score -= (p.screenIn - 6.1) * 120;
        why.push(p.screenIn <= minScreen + 0.05 ? `${p.screenIn}" screen, the most compact we carry` : `${p.screenIn}" screen`);
      }
      if (prefs.camera) why.push(p.camera >= 5 ? "top-tier camera (5/5)" : `camera ${p.camera}/5`);
      if (prefs.gaming) why.push(p.gaming >= 5 ? "top-tier gaming performance" : `gaming ${p.gaming}/5`);
      if (prefs.brand) {
        if (p.brand === prefs.brand) {
          score += 25;
          why.push(`the ${prefs.brand === "Apple" ? "iPhone" : p.brand} you asked for`);
        } else score -= 15;
      }
      if (budget) why.push(price <= budget ? `${usd(price)}, under your ${usd(budget)}` : `${usd(price)}, over your ${usd(budget)}`);

      if (p.simple) why.unshift("Big buttons and simple mode");
      why.push(`${gb}GB fits ${m.device.storageUsedGB}GB of use with room to grow`);
      if (!prefs.battery) why.push(`${p.batteryHours}h battery`);
      if (!prefs.camera && p.camera >= m.usage.camera) why.push(`camera ${p.camera}/5 covers ${m.name.split(/\s+/)[0]}'s ${m.usage.camera}/5 use`);
      return { phoneId: p.id, name: p.name, storageGB: gb, price, why, score };
    })
    .sort((a, b) => b.score - a.score)
    // With a budget, only show over-budget phones if fewer than two fit.
    .filter((r, _i, all) => !budget || r.price <= budget || all.filter((x) => x.price <= budget).length < 2)
    .slice(0, 3)
    .map(({ score: _score, ...r }) => r);
}

/** Merge new preferences into what we already know about someone. */
export function mergePrefs(old: Prefs = {}, next: Prefs): Prefs {
  const merged: Prefs = { ...old, ...next };
  if (next.bigScreen) delete merged.smallScreen;
  if (next.smallScreen) delete merged.bigScreen;
  return merged;
}

export function promosFor(world: World, id: string, day: number, category?: string): Promo[] {
  return world.offers.promos.filter((p) => promoCovers(p, id, category) && p.endsOnDay > day);
}

/** Words in a store URL: "/lg-oled-c5?size=65in" -> "lg oled c 5 size 65 in". */
function linkWords(url: string) {
  let decoded = url;
  try {
    const u = new URL(url);
    decoded = `${u.pathname} ${u.search}`;
  } catch {}
  decoded = decodeURIComponent(decoded);
  return { decoded, words: decoded.replace(/[-_/+=&?.,:]+/g, " ").replace(/([a-z])(\d)/gi, "$1 $2").replace(/(\d)([a-z])/gi, "$1 $2") };
}

/** "Close your tabs" for anything: a pasted store URL -> a catalog phone (+ storage) or product (+ size). */
export function parseLink(world: World, url: string):
  | { kind: "phone"; phone: Phone; storageGB: number }
  | { kind: "product"; product: Product; variant: string }
  | undefined {
  const { decoded, words } = linkWords(url);
  const ph = bestMatch(world.catalog.phones, words);
  const pr = bestMatch(world.catalog.products ?? [], words);
  if (ph && (!pr || ph.score >= pr.score)) {
    const hit = parseProductLink(world, url)!;
    return { kind: "phone", ...hit };
  }
  if (!pr) return undefined;
  return { kind: "product", product: pr.item, variant: pickVariant(pr.item, decoded) };
}

/** "Close your tabs": turn a pasted store URL into a catalog phone + storage. */
export function parseProductLink(world: World, url: string): { phone: Phone; storageGB: number } | undefined {
  let decoded = url;
  try {
    const u = new URL(url);
    decoded = `${u.pathname} ${u.search}`;
  } catch {}
  decoded = decodeURIComponent(decoded);
  const words = decoded.replace(/[-_/+=&?.,:]+/g, " ").replace(/([a-z])(\d)/gi, "$1 $2").replace(/(\d)([a-z])/gi, "$1 $2");
  const p = findPhone(world, words);
  if (!p) return undefined;
  const opts = Object.keys(p.prices).map(Number);
  const nums = [...decoded.matchAll(/(\d{2,4})\s*(?:gb)?/gi)].map((x) => Number(x[1]));
  const gb = nums.find((n) => opts.includes(n)) ?? Math.min(...opts);
  return { phone: p, storageGB: gb };
}

/** "long battery life and a bigger screen, under $800, iPhone" */
export function describePrefs(p: Prefs): string {
  const parts = (Object.keys(PREF_LABELS) as (keyof typeof PREF_LABELS)[])
    .filter((k) => p[k] && !(k === "cheap" && p.budget)) // "under $500" already says it
    .map((k) => PREF_LABELS[k]);
  if (p.brand) parts.push(p.brand === "Apple" ? "an iPhone" : `a ${p.brand} phone`);
  if (p.budget) parts.push(`under ${usd(p.budget)}`);
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** "Our budget is $1,500" / "family budget 2000" / "we can spend $1200" -> 1500. Undefined if not a family budget. */
export function familyBudget(text: string): number | undefined {
  const t = text.toLowerCase().replace(/,(\d{3})/g, "$1");
  if (!/\b(our|family|household|total|we have|we can spend|we've got)\b/.test(t)) return undefined;
  const m = t.match(/(?:budget|spend|have|got)[^$\d]{0,20}\$?\s*(\d{3,5})/) ?? t.match(/\$\s*(\d{3,5})/);
  return m ? Number(m[1]) : undefined;
}

// ---------------------------------------------------------------- everything else the store sells

const COOLING_OFF_DAYS = 30; // "sleep on it" for a want, not a need

export const categories = (world: World): Record<string, Category> => world.catalog.categories ?? {};

export function product(world: World, id: string): Product {
  const p = world.catalog.products?.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown product "${id}"`);
  return p;
}

/** Loose name match ("macbook air", "lg oled") -> catalog product. */
export function findProduct(world: World, query: string): Product | undefined {
  return bestMatch(world.catalog.products ?? [], query)?.item;
}

/** "what laptop should I get", "a new tv" -> "laptop", "tv". Longest phrase wins ("air fryer" over "air"). */
export function findCategory(world: World, text: string): string | undefined {
  const t = ` ${norm(text)} `;
  const hits = Object.entries(categories(world))
    .flatMap(([id, c]) => c.words.map((w) => ({ id, w: norm(w) })))
    .filter(({ w }) => t.includes(` ${w} `))
    .sort((a, b) => b.w.length - a.w.length);
  return hits[0]?.id;
}

/** Cheapest variant first ("55in" before "65in"). */
export const variants = (p: Product) => Object.keys(p.prices).sort((a, b) => p.prices[a] - p.prices[b]);

/** A variant named in free text ("65 inch", "1tb", "queen"), else the cheapest. */
export function pickVariant(p: Product, text = ""): string {
  const t = norm(text).replace(/(\d) (in|inch|gb|tb)\b/g, "$1$2").replace(/inch\b/g, "in");
  return variants(p).find((v) => v !== "std" && new RegExp(`\\b${norm(v).replace(/ /g, "")}\\b`).test(t)) ?? variants(p)[0];
}

/** "MacBook Air 13 512GB", "AirPods Pro 3" (no "std"). */
export const productLabel = (p: Product, variant: string) => (variant === "std" ? p.name : `${p.name} ${variant}`);

/** What this person (or the household) already has in this category: their own first, then a shared one. */
export function ownedFor(world: World, memberId: string, category: string): Owned | undefined {
  const owned = world.household.owned ?? [];
  return owned.find((o) => o.memberId === memberId && o.category === category) ?? owned.find((o) => !o.memberId && o.category === category);
}

/** Is a protection plan worth it for this product? (Only asked for fragile categories.) */
export function productProtection(m: Member, price: number): { verdict: "ADD" | "SKIP" | "OPTIONAL"; monthly: number; reason: string } {
  const monthly = Math.max(3, Math.round(price * 0.01));
  const young = m.age < 20 || ["teen", "kid"].includes(m.role);
  if (price >= 800 && young) return { verdict: "ADD", monthly, reason: `Teens drop things: ${usd(monthly)}/mo protects a ${usd(price)} purchase` };
  if (price < 250) return { verdict: "SKIP", monthly, reason: `Skip it: ${usd(monthly * 12)}/yr is a lot next to a ${usd(price)} purchase` };
  return { verdict: "OPTIONAL", monthly, reason: `Optional: ${usd(monthly * 12)}/yr. Check the card you pay with first, many add a free extra year of warranty` };
}

const years = (months: number) => (months % 12 === 0 ? `${months / 12} years` : `${months} months`);

function reviewProduct(world: World, item: CartItem, day: number, opts: TrialOptions, cart: CartItem[]): Ruling {
  const m = member(world, item.memberId);
  const qty = Math.max(1, Math.round(item.quantity ?? 1));
  const picked = item.productId ? product(world, item.productId) : undefined;
  if (!picked && !item.custom) throw new Error(`Cart item ${item.id} has no product`);
  const category = picked?.category ?? item.custom?.category;
  const cat = category ? categories(world)[category] : undefined;
  const pickedVariant = picked ? (item.variant && item.variant in picked.prices ? item.variant : variants(picked)[0]) : "std";
  const many = (name: string) => (qty > 1 ? `${qty} × ${name}` : name);
  const pickedName = picked ? productLabel(picked, pickedVariant) : item.custom!.name;
  const pickedUnit = picked ? picked.prices[pickedVariant] : item.custom!.price;
  const originalCost = pickedUnit * qty;
  const label = `${m.name} · ${many(pickedName)}`;
  const math: { label: string; amount: number }[] = [{ label: `${many(pickedName)}, as argued`, amount: originalCost }];

  // 0. The same thing twice for the same person: strike the extra copy.
  const sameAs = (c: CartItem) =>
    c.kind === "product" && c.memberId === m.id &&
    (picked ? c.productId === picked.id : c.custom?.name.toLowerCase() === item.custom!.name.toLowerCase());
  const first = cart.find(sameAs);
  if (first && first.id !== item.id) {
    return {
      itemId: item.id, memberId: m.id, label, stamp: "CUT",
      reasons: [`Already in the cart for ${m.name}. One is enough`],
      originalCost, nowCost: 0, heldCost: 0, savings: originalCost,
      math: [...math, { label: "Struck: duplicate", amount: -originalCost }],
    };
  }

  const reasons: string[] = [];
  // 1. Right product? Budget pressure (private DM): a premium pick goes to a cheaper one rated nearly as well.
  let target = picked;
  let variant = pickedVariant;
  if (picked && opts.tightBudget && picked.tier === "flagship") {
    const cheaper = (world.catalog.products ?? [])
      .filter((p) => p.category === picked.category && p.tier !== "flagship" && p.rating >= picked.rating - 1)
      .sort((a, b) => Number(b.brand === picked.brand) - Number(a.brand === picked.brand) || b.rating - a.rating || Math.min(...Object.values(a.prices)) - Math.min(...Object.values(b.prices)))[0];
    if (cheaper) {
      target = cheaper;
      variant = pickedVariant in cheaper.prices ? pickedVariant : variants(cheaper)[0];
      reasons.push(`Keeping this month's total in check: the ${cheaper.name} is rated ${cheaper.rating}/5 for less`);
    }
  }
  const unit = target ? target.prices[variant] : pickedUnit;
  const name = target ? productLabel(target, variant) : pickedName;
  let price = unit * qty;
  if (price !== originalCost) math.push({ label: `Switch to ${many(name)}`, amount: price - originalCost });

  // 2. What they already own: trade it in, and is it actually done?
  const owned = category ? ownedFor(world, m.id, category) : undefined;
  if (owned?.tradeInValue && !owned.broken) {
    reasons.push(`Trade in the ${owned.name}: −${usd(owned.tradeInValue)}`);
    price -= owned.tradeInValue;
    math.push({ label: `Trade-in: ${owned.name}`, amount: -owned.tradeInValue });
  }
  const urgent = !!owned?.broken;
  const stillGood = !!owned && !owned.broken && !!cat?.lifespanMonths && owned.ageMonths < cat.lifespanMonths;

  // 3. Timing: a sale running now, or one coming soon.
  const id = target?.id ?? `custom:${item.id}`;
  const custom = target ? undefined : { price: unit, category };
  const { active, upcoming } = promoFor(world, id, day, category);
  if (active) {
    const off = promoCredit(active, unit) * qty;
    reasons.push(`${active.name} is live: ${promoText(active, unit * qty)}`);
    price -= off;
    math.push({ label: `${active.name} (live now)`, amount: -off });
  }
  let holdUntilDay: number | undefined;
  if (!urgent && upcoming && !active) {
    holdUntilDay = upcoming.startsOnDay;
    const off = promoCredit(upcoming, unit) * qty;
    reasons.push(`${upcoming.name} starts in ${upcoming.startsOnDay - day} days: ${promoText(upcoming, unit * qty)}`);
    price -= off;
    math.push({ label: `${upcoming.name} (from day ${upcoming.startsOnDay})`, amount: -off });
  }
  if (stillGood && holdUntilDay === undefined && !active) {
    holdUntilDay = day + COOLING_OFF_DAYS;
    reasons.push(`It's a want, not a need yet: sleep on it for ${COOLING_OFF_DAYS} days. Still want it then? Buy it`);
  }
  if (owned?.broken) reasons.unshift(`The ${owned.name} is broken. Replacing it now makes sense`);
  else if (stillGood) reasons.unshift(`The ${owned!.name} still works and is ${owned!.ageMonths} months old. A ${cat!.label} lasts about ${years(cat!.lifespanMonths)}`);
  else if (owned && cat?.lifespanMonths) reasons.unshift(`The ${owned.name} is ${owned.ageMonths} months old, past the ~${years(cat.lifespanMonths)} a ${cat.label} lasts. Fair to replace`);
  if (!reasons.length) reasons.push(`Fair price. No sale coming up in the next ${PROMO_LOOKAHEAD_DAYS} days`);

  const changed = target !== picked;
  const stamp = holdUntilDay !== undefined ? "WAIT" : changed ? "SWAP" : "KEEP";
  const witness = stamp === "WAIT" && owned && !owned.broken
    ? `I am the ${owned.name}. I am ${owned.ageMonths} months old and I still do my job every day. I'd like to be heard before I'm replaced.`
    : undefined;
  return {
    itemId: item.id,
    memberId: m.id,
    label,
    stamp,
    reasons,
    originalCost,
    nowCost: stamp === "WAIT" ? 0 : price,
    heldCost: stamp === "WAIT" ? price : 0,
    savings: originalCost - price,
    holdUntilDay,
    proposed: { productId: id, variant, label: many(name) },
    witness,
    witnessOf: witness ? (owned!.memberId ? `${m.name}'s ${owned!.name}` : `the household's ${owned!.name}`) : undefined,
    urgent,
    math,
    protection: cat?.fragile ? productProtection(m, unit) : undefined,
    track: priceTrack(world, id, variant, day, Math.max(90, (holdUntilDay ?? day) - day + 40), custom),
  };
}

export interface ProductPick {
  productId: string;
  name: string;
  variant: string;
  price: number;
  why: string[];
}

/** Matchmaker for anything but phones: top 3 in a category, by how well it does the job for the money. */
export function recommendProducts(
  world: World, memberId: string, category: string, opts: { budget?: number; brand?: string; cheap?: boolean; best?: boolean } = {},
): ProductPick[] {
  const m = member(world, memberId);
  const cat = categories(world)[category];
  if (!cat) throw new Error(`Unknown category "${category}". Categories: ${Object.keys(categories(world)).join(", ")}`);
  const owned = ownedFor(world, m.id, category);
  const brand = opts.brand?.toLowerCase();
  return (world.catalog.products ?? [])
    .filter((p) => p.category === category)
    .map((p) => {
      const variant = variants(p)[0];
      const price = p.prices[variant];
      const why: string[] = [];
      let score = p.rating * 20 - price / (opts.cheap ? 10 : opts.best ? 200 : 40);
      if (opts.budget && price > opts.budget) score -= 50;
      if (brand) {
        if (p.brand.toLowerCase() === brand) {
          score += 25;
          why.push(`the ${p.brand} you asked for`);
        } else score -= 15;
      }
      why.push(`rated ${p.rating}/5`);
      if (opts.budget) why.push(price <= opts.budget ? `${usd(price)}, under your ${usd(opts.budget)}` : `${usd(price)}, over your ${usd(opts.budget)}`);
      if (variants(p).length > 1) why.push(`from ${usd(price)} (${variant})`);
      if (owned?.tradeInValue && !owned.broken) why.push(`trade in the ${owned.name} for −${usd(owned.tradeInValue)}`);
      return { productId: p.id, name: p.name, variant, price, why, score };
    })
    .sort((a, b) => b.score - a.score)
    .filter((r, _i, all) => !opts.budget || r.price <= opts.budget || all.filter((x) => x.price <= opts.budget!).length < 2)
    .slice(0, 3)
    .map(({ score: _score, ...r }) => r);
}

/** "iPhone 17 Pro 256GB", "2 × Nike Pegasus 41", "Hotspot Plus": how a cart line reads anywhere. */
export function cartLabel(world: World, i: CartItem): string {
  const many = (name: string) => ((i.quantity ?? 1) > 1 ? `${i.quantity} × ${name}` : name);
  if (i.kind === "device") return `${phone(world, i.phoneId!).name} ${i.storageGB}GB`;
  if (i.kind === "product") return many(i.custom?.name ?? productLabel(product(world, i.productId!), i.variant ?? variants(product(world, i.productId!))[0]));
  return world.catalog.addons.find((a) => a.id === i.addonId)?.name ?? "an add-on";
}

/** Sticker price of a cart line (add-ons: a year of them). */
export function cartPrice(world: World, i: CartItem): number {
  if (i.kind === "device") return phone(world, i.phoneId!).prices[String(i.storageGB)];
  if (i.kind === "product") {
    const p = i.productId ? product(world, i.productId) : undefined;
    return (p ? p.prices[i.variant ?? variants(p)[0]] : i.custom!.price) * (i.quantity ?? 1);
  }
  return (world.catalog.addons.find((a) => a.id === i.addonId)?.monthly ?? 0) * 12;
}
