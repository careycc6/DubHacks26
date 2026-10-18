// The pricing engine. Deterministic and LLM-free: every number the agent says comes from here.
import type {
  Accessory, CartItem, Category, Member, NestRuling, Owned, Phone, Product, Promo, Recommendation, Ruling, StoreLink, Trial, World,
} from "./types.ts";

const LOW_BATTERY = 80; // below this, upgrading now is justified
const BATTERY_SERVICE = 99; // typical carrier/maker battery replacement
const PROMO_LOOKAHEAD_DAYS = 90;
const DAYS_PER_PAYMENT = 30;
export const SCREEN_REPAIR = 129;

export const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export function member(world: World, id: string): Member {
  const m = world.household.members.find((x) => x.id === id);
  if (!m) throw new Error(`Unknown member "${id}"`);
  return m;
}

/** Roles that run the cart (and whose money worries count). */
export const MANAGER_ROLES = new Set(["parent", "partner"]);
export const managers = (world: World) => world.household.members.filter((m) => MANAGER_ROLES.has(m.role));

const TITLES: [RegExp, string][] = [
  [/\b(dad|father)\b/, "dad"],
  [/\b(mom|mum|mother)\b/, "mom"],
  [/\b(grandma|grandmother|abuela)\b/, "grandma"],
];

/** "dad", "mom", "grandma" → a member: whoever the household calls that (`aka`), else the only parent / a grandparent. */
export function memberByTitle(world: World, text: string): Member | undefined {
  const t = text.toLowerCase();
  for (const [re, title] of TITLES) {
    if (!re.test(t)) continue;
    if (title === "grandma") return world.household.members.find((m) => m.aka?.includes(title)) ?? world.household.members.find((m) => m.role === "grandparent");
    // /setup can re-role a slot, so an example "dad" only counts while they're still a parent.
    const parents = managers(world);
    const named = parents.find((m) => m.aka?.includes(title));
    if (named) return named;
    if (parents.length === 1) return parents[0]; // two parents and no aka: don't guess which one
  }
  return undefined;
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

const BILL_CREDIT_MONTHS = 24;
/** Carriers spread a phone over 24 monthly payments; "about $17/mo" is the price after trade-in and deals, rounded up. */
export const DEVICE_MONTHS = 24;
export const perMonth = (price: number) => Math.ceil(price / DEVICE_MONTHS);

/** What a plan-locked deal costs in extra plan fees over its bill-credit period (0 if it needs no plan change). */
export function planCost(x: Promo, currentPlan?: string): number {
  if (!x.requiresPlan || x.requiresPlan === currentPlan) return 0;
  return (x.planExtraMonthly ?? 0) * (x.billCreditMonths ?? BILL_CREDIT_MONTHS);
}

/** What a deal is really worth on this sticker: the credit (or % off) minus any plan change it needs. */
const dealValue = (x: Promo, plan: string | undefined, sticker: number) => promoCredit(x, sticker) - planCost(x, plan);

/** A deal counts only if this person qualifies (has a trade-in when it needs one) and it's worth any plan change. */
const qualifies = (x: Promo, sticker: number, m?: Member, plan?: string) =>
  (!x.requiresTradeIn || !m || m.device.tradeInValue > 0) && dealValue(x, plan, sticker) > 0;

/** The best deal running now and the best one starting soon, for a phone or product (by id or category). */
const promoFor = (world: World, id: string, day: number, opts: { m?: Member; category?: string; sticker: number }) => {
  const plan = world.household.plan;
  const { m, category, sticker } = opts;
  const mine = world.offers.promos.filter((x) => promoCovers(x, id, category));
  const best = (xs: Promo[]) => xs.sort((a, b) => dealValue(b, plan, sticker) - dealValue(a, plan, sticker))[0];
  return {
    active: best(mine.filter((x) => x.startsOnDay <= day && day < x.endsOnDay && qualifies(x, sticker, m, plan))),
    upcoming: best(mine.filter((x) => x.startsOnDay > day && x.startsOnDay - day <= PROMO_LOOKAHEAD_DAYS && qualifies(x, sticker, m, plan))),
    // Deals the court turned down (a plan that costs more than it saves), so it can say why.
    notWorthIt: mine.filter((x) => x.startsOnDay <= day + PROMO_LOOKAHEAD_DAYS && day < x.endsOnDay && x.requiresPlan && !qualifies(x, sticker, m, plan)),
  };
};

/** "−$312 (as 24 monthly bill credits; needs Premium Unlimited at +$10/mo, so −$72 net)", or "20% off (−$300)". */
function dealText(x: Promo, plan: string | undefined, sticker: number): string {
  const extra = planCost(x, plan);
  const parts: string[] = [];
  if (x.billCreditMonths) parts.push(`as ${x.billCreditMonths} monthly bill credits, so stay ${x.billCreditMonths} months to get it all`);
  if (extra) parts.push(`needs ${x.requiresPlan} at +${usd(x.planExtraMonthly ?? 0)}/mo, so ${usd(dealValue(x, plan, sticker))} net`);
  return `${promoText(x, sticker)}${parts.length ? ` (${parts.join("; ")})` : ""}`;
}

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
  /** What's left of the money the family set aside for phones (the whole plan: now and later). */
  budget?: number;
  /** Internal: trim flagships to mid tier to fit the budget (set when the first pass is over budget). */
  trimForBudget?: boolean;
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

/** Store price on a given demo day: sticker minus the best deal running that day that the ruling would accept
 *  (for `m` when known). Pass `custom` for items not in the catalog. */
export function priceOn(world: World, id: string, variant: string | number, day: number, custom?: { price: number; category?: string }, m?: Member): number {
  const { price, category } = custom ?? sticker(world, id, variant);
  const promo = promoFor(world, id, day, { m, category, sticker: price }).active;
  return price - (promo ? promoCredit(promo, price) : 0);
}

export interface PriceTrack {
  points: { day: number; price: number }[];
  now: number;
  lowest: { day: number; price: number };
}

/** Price over the next `span` days, with every promo start/end as its own point, so drops show exactly. */
export function priceTrack(
  world: World, id: string, variant: string | number, fromDay: number, span = 120, custom?: { price: number; category?: string }, m?: Member,
): PriceTrack {
  const { category } = custom ?? sticker(world, id, variant);
  const days = new Set<number>();
  for (let d = fromDay; d <= fromDay + span; d += 10) days.add(d);
  for (const x of world.offers.promos.filter((x) => promoCovers(x, id, category))) {
    for (const d of [x.startsOnDay - 1, x.startsOnDay, x.endsOnDay - 1, x.endsOnDay]) if (d >= fromDay && d <= fromDay + span) days.add(d);
  }
  const points = [...days].sort((a, b) => a - b).map((day) => ({ day, price: priceOn(world, id, variant, day, custom, m) }));
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

// Stores pay far less for a phone with a cracked screen. If the gap is bigger than a screen repair,
// fixing it first is the better deal, and the court says so (the value is net of the repair).
const CRACKED_TRADE_IN = 0.4;
export function tradeIn(m: Member): { value: number; reason: string } {
  const full = m.device.tradeInValue;
  const who = `${m.name}'s ${m.device.model}`;
  if (!m.device.screenCracked || full <= 0) return { value: full, reason: `Trade in ${who}: −${usd(full)}` };
  const cracked = Math.round((full * CRACKED_TRADE_IN) / 5) * 5;
  const fixFirst = full - SCREEN_REPAIR;
  return fixFirst > cracked
    ? { value: fixFirst, reason: `Fix the screen first (${usd(SCREEN_REPAIR)}), then trade in ${who} for ${usd(full)} instead of about ${usd(cracked)} cracked: −${usd(fixFirst)} after the repair` }
    : { value: cracked, reason: `Trade in ${who} as is: about −${usd(cracked)} with the cracked screen (−${usd(full)} if it weren't)` };
}

/** The court's ruling on a phone, unless a parent overruled it (then: buy as picked, today, with the honest difference). */
function reviewDevice(world: World, item: CartItem, day: number, opts: TrialOptions = {}): Ruling {
  const court = judgeDevice(world, item, day, opts);
  return item.overruledBy ? overrule(world, item, day, court) : court;
}

function judgeDevice(world: World, item: CartItem, day: number, opts: TrialOptions = {}): Ruling {
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
  if ((opts.tightBudget && m.device.batteryHealth < LOW_BATTERY || opts.trimForBudget) && target === picked && picked.tier === "flagship") {
    const mid = world.catalog.phones.find((p) => p.brand === picked.brand && p.tier === "mid");
    const wants = opts.prefs?.[m.id] ?? {};
    const keepsWhatTheyWant = !!mid && !(wants.bigScreen && mid.screenIn < picked.screenIn) && !(wants.camera && mid.camera < picked.camera);
    if (mid && keepsWhatTheyWant && mid.camera >= m.usage.camera && mid.gaming >= m.usage.gaming) {
      target = mid;
      reasons.push(
        opts.trimForBudget
          ? `To fit the family's phone budget: the ${mid.name} covers how ${m.name.split(/\s+/)[0]} uses a phone`
          : `Keeping the total in check: the ${mid.name} has the ${mid.camera}/5 camera ${m.name} actually uses`,
      );
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

  // 3. Trade-in the family forgot about (worth less with a cracked screen; see tradeIn()).
  const plan = world.household.plan;
  const ti = tradeIn(m);
  if (ti.value > 0) {
    reasons.push(ti.reason);
    price -= ti.value;
    math.push({ label: `Trade-in: ${m.device.model}${m.device.screenCracked ? " (cracked screen)" : ""}`, amount: -ti.value });
  }

  // 4. Timing: should this purchase wait?
  const { active, upcoming, notWorthIt } = promoFor(world, target.id, day, { m, sticker: target.prices[String(gb)] });
  let tradeInDeal = 0; // promo credit that only exists with a trade-in
  if (active) {
    const off = dealValue(active, plan, target.prices[String(gb)]);
    reasons.push(`${active.name} is live: ${dealText(active, plan, target.prices[String(gb)])}`);
    price -= off;
    math.push({ label: `${active.name} (live now)`, amount: -off });
    if (active.requiresTradeIn) tradeInDeal = off;
  }
  const healthy = m.device.batteryHealth >= LOW_BATTERY;
  let holdUntilDay: number | undefined;
  if (healthy && upcoming && !active) {
    holdUntilDay = upcoming.startsOnDay;
    const off = dealValue(upcoming, plan, target.prices[String(gb)]);
    reasons.push(`${upcoming.name} starts in ${upcoming.startsOnDay - day} days: ${dealText(upcoming, plan, target.prices[String(gb)])}`);
    price -= off;
    math.push({ label: `${upcoming.name} (from day ${upcoming.startsOnDay})`, amount: -off });
    if (upcoming.requiresTradeIn) tradeInDeal = off;
  }
  for (const x of notWorthIt.filter((x) => x !== active && x !== upcoming)) {
    reasons.push(`Skip the ${x.name}: it needs ${x.requiresPlan} at +${usd(x.planExtraMonthly ?? 0)}/mo, which costs ${usd(planCost(x, plan))} over ${x.billCreditMonths ?? BILL_CREDIT_MONTHS} months for a ${usd(promoCredit(x, target.prices[String(gb)]))} credit`);
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
    // A worn battery on a phone that is otherwise fine can be swapped for far less than a new phone.
    if (!m.device.screenCracked && m.device.ageMonths <= 48) reasons.splice(1, 0, `Or consider a battery replacement (about ${usd(BATTERY_SERVICE)}): it can give the ${m.device.model} another year or two`);
  }

  // A cracked screen on an otherwise healthy phone is a repair, not a reason to buy a new phone.
  const repairNow = holdUntilDay !== undefined && !!m.device.screenCracked;
  // Repaired today, so by the time it's traded in it's worth the full amount again.
  if (repairNow && ti.value < m.device.tradeInValue) {
    price -= m.device.tradeInValue - ti.value;
    reasons[reasons.indexOf(ti.reason)] = `Trade in ${m.name}'s ${m.device.model} once it's repaired: −${usd(m.device.tradeInValue)}`;
    const line = math.find((l) => l.label.startsWith("Trade-in:"));
    if (line) Object.assign(line, { label: `Trade-in: ${m.device.model} (repaired first)`, amount: -m.device.tradeInValue });
    ti.value = m.device.tradeInValue;
  }
  if (repairNow) reasons.splice(1, 0, `The evidence shows a cracked screen. A ${usd(SCREEN_REPAIR)} screen repair fixes that today. A new phone doesn't have to`);
  else if (m.device.screenCracked) reasons.splice(1, 0, "The evidence shows a cracked screen too");

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
    tradeIn: ti.value > 0
      ? { device: m.device.model, value: ti.value, withTradeIn: price, withoutTradeIn: price + ti.value + tradeInDeal }
      : undefined,
    track: priceTrack(world, target.id, gb, day, Math.max(90, (holdUntilDay ?? day) - day + 40), undefined, m),
  };
}

/** A parent overruled the court: buy the phone they picked, today. Trade-in and live deals still apply; nothing is hidden. */
function overrule(world: World, item: CartItem, day: number, court: Ruling): Ruling {
  const m = member(world, item.memberId);
  const by = world.household.members.find((x) => x.id === item.overruledBy)?.name ?? "a parent";
  const picked = phone(world, item.phoneId!);
  const gb = item.storageGB ?? storageOptions(picked)[0];
  const sticker = picked.prices[String(gb)] ?? court.originalCost;
  const plan = world.household.plan;
  const first = m.name.split(/\s+/)[0];
  const reasons = [`${by.split(/\s+/)[0]}'s call: ${first} gets it today, as picked`];
  let price = sticker;
  const math: { label: string; amount: number }[] = [{ label: `${picked.name} ${gb}GB, as picked`, amount: sticker }];
  const ti = tradeIn(m); // a cracked screen trades in for less
  if (ti.value > 0) {
    reasons.push(ti.reason);
    price -= ti.value;
    math.push({ label: `Trade-in: ${m.device.model}${m.device.screenCracked ? " (cracked screen)" : ""}`, amount: -ti.value });
  }
  const { active } = promoFor(world, picked.id, day, { m, sticker });
  if (active) {
    const off = dealValue(active, plan, sticker);
    reasons.push(`${active.name} is live: ${dealText(active, plan, sticker)}`);
    price -= off;
    math.push({ label: `${active.name} (live now)`, amount: -off });
  }
  const paymentsLeft = Math.max(0, Math.ceil((m.device.installmentsLeft * DAYS_PER_PAYMENT - day) / DAYS_PER_PAYMENT));
  if (paymentsLeft > 0) reasons.push(`Pays off the last ${paymentsLeft} payments on the ${m.device.model} (${usd(paymentsLeft * m.device.monthlyInstallment)}) early`);
  const savings = sticker - price;
  const extra = Math.max(0, court.savings - savings);
  const courtPlan = court.stamp === "WAIT"
    ? `${court.proposed?.label ?? picked.name} for ${usd(court.heldCost)} on day ${court.holdUntilDay}`
    : `${court.proposed?.label ?? picked.name} for ${usd(court.nowCost)} today`;
  if (extra > 0) reasons.push(`For the record: the court's plan was the ${courtPlan}. This costs ${usd(extra)} more`);
  return {
    ...court,
    stamp: "KEEP",
    reasons,
    originalCost: sticker,
    nowCost: price,
    heldCost: 0,
    savings,
    holdUntilDay: undefined,
    proposed: { phoneId: picked.id, storageGB: gb, label: `${picked.name} ${gb}GB` },
    witness: undefined,
    protection: protectionAdvice(m, sticker),
    tradeIn: ti.value > 0 ? { device: m.device.model, value: ti.value, withTradeIn: price, withoutTradeIn: price + ti.value } : undefined,
    track: priceTrack(world, picked.id, gb, day, 90, undefined, m),
    math,
    overruled: { by, courtPlan, extra },
  };
}

/**
 * What would change this ruling, tested against the engine (never guessed): a worn battery, saying they'll
 * use the Pro features. Each hint is only offered if trying it actually flips the ruling.
 */
export function whatWouldChange(world: World, cart: CartItem[], itemId: string, day: number, opts: TrialOptions = {}): string[] {
  const item = cart.find((i) => i.id === itemId);
  if (!item || item.kind !== "device" || item.overruledBy) return [];
  const now = judgeDevice(world, item, day, opts);
  if (now.stamp === "KEEP") return [];
  const m = member(world, item.memberId);
  const hints: string[] = [];
  const tryWith = (edit: (w: World) => void, o: TrialOptions = opts) => {
    const w = structuredClone(world);
    edit(w);
    return judgeDevice(w, item, day, o);
  };
  if (now.stamp === "WAIT" && m.device.batteryHealth >= LOW_BATTERY && !tryWith((w) => (member(w, m.id).device.batteryHealth = LOW_BATTERY - 1)).holdUntilDay) {
    hints.push(`Battery Health under ${LOW_BATTERY}%: send a screenshot (Settings → Battery)`);
  }
  if (now.proposed && now.proposed.phoneId !== item.phoneId) {
    const prefs = opts.prefs?.[m.id] ?? {};
    for (const [want, words] of [["camera", "you'll really use the Pro camera"], ["gaming", "you play demanding games"]] as const) {
      if (prefs[want]) continue;
      const r = tryWith(() => {}, { ...opts, prefs: { ...opts.prefs, [m.id]: { ...prefs, [want]: true } } });
      if (r.proposed?.phoneId === item.phoneId) { hints.push(`Tell the court ${words} (e.g. "I shoot video for school")`); break; }
    }
  }
  return hints;
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

// A hand-me-down: a parent upgrading anyway passes their old phone to a teen or kid who's also in the cart.
// It isn't free: the family gives up that phone's trade-in, plus any deal that only pays with a trade-in.
// The court prices it honestly and says which way wins; it never changes the ruling by itself.
const HAND_ME_DOWN_BATTERY = 85; // a gift with a tired battery isn't much of a gift
function priceHandMeDowns(world: World, rulings: Ruling[], day: number) {
  const phones = rulings.filter((r) => r.proposed && r.memberId && r.stamp !== "CUT");
  for (const r of phones) {
    const kid = member(world, r.memberId!);
    if (!["teen", "kid"].includes(kid.role)) continue;
    const best = phones
      .filter((g) => g !== r)
      .map((g) => ({ g, m: member(world, g.memberId!) }))
      .filter(({ m }) => ["parent", "partner"].includes(m.role) && !m.device.screenCracked && m.device.batteryHealth >= HAND_ME_DOWN_BATTERY && m.device.ageMonths < kid.device.ageMonths)
      .map(({ g, m }) => ({ g, m, forgone: g.tradeIn ? g.tradeIn.withoutTradeIn - g.tradeIn.withTradeIn : m.device.tradeInValue }))
      .sort((a, b) => a.forgone - b.forgone)[0];
    if (!best) continue;
    const instead = r.stamp === "WAIT" ? r.heldCost : r.nowCost;
    r.handMeDown = {
      from: best.m.id, device: best.m.device.model, batteryHealth: best.m.device.batteryHealth,
      onDay: best.g.stamp === "WAIT" ? best.g.holdUntilDay ?? day : day,
      forgone: best.forgone, instead, saves: instead - best.forgone,
    };
  }
}

/** One line for a hand-me-down: what it saves, or why trading the phone in wins. */
export function handMeDownText(world: World, r: Ruling): string | undefined {
  const h = r.handMeDown;
  if (!h) return undefined;
  const giver = member(world, h.from).name.split(/\s+/)[0];
  const kid = member(world, r.memberId!).name.split(/\s+/)[0];
  return h.saves > 0
    ? `Hand-me-down option: ${kid} takes ${giver}'s ${h.device} (${h.batteryHealth}% battery) on day ${h.onDay}. It costs the ${usd(h.forgone)} trade-in, but skips a ${usd(h.instead)} phone: ${usd(h.saves)} less`
    : `Checked a hand-me-down: ${giver}'s ${h.device} to ${kid} would cost ${usd(-h.saves)} more than trading it in (${usd(h.forgone)} in trade-in and deals vs a ${usd(h.instead)} phone)`;
}

/** Put the whole cart (plus the account's dead weight) on trial. */
export function runTrial(world: World, cart: CartItem[], day: number, opts: TrialOptions = {}): Trial {
  const rulings = cart.map((item) =>
    item.kind === "device" ? reviewDevice(world, item, day, opts)
    : item.kind === "product" ? reviewProduct(world, item, day, opts, cart)
    : item.kind === "accessory" ? reviewAccessory(world, item, cart)
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
      // Add-ons and accessories bought for a phone that has to wait, wait with it.
      if (r.stamp !== "KEEP" || r.proposed || !r.memberId || r.itemId.startsWith("account:")) continue;
      const phoneRuling = rulings.find((x) => x.memberId === r.memberId && x.proposed?.phoneId && x.stamp === "WAIT");
      if (!phoneRuling) continue;
      r.stamp = "WAIT";
      r.holdUntilDay = phoneRuling.holdUntilDay;
      r.heldCost = r.nowCost;
      r.nowCost = 0;
      r.reasons.unshift(r.label.includes("Protection") ? "Starts the day the new phone does" : "Buy it together with the new phone");
    }
  };
  holdAddonsWithPhones();
  priceHandMeDowns(world, rulings, day);

  // Over the family budget today? Nice-to-haves (not phones, nothing replacing something broken) wait a month
  // first, priciest first: a pair of shoes shouldn't cost someone the phone they need.
  const deferred = new Set<Ruling>();
  if (opts.budget !== undefined && sum((r) => r.nowCost) > opts.budget) {
    const extras = rulings
      .filter((r) => (r.stamp === "KEEP" || r.stamp === "SWAP") && r.proposed?.productId !== undefined && !r.urgent)
      .sort((a, b) => b.nowCost - a.nowCost);
    for (const r of extras) {
      if (sum((x) => x.nowCost) <= opts.budget) break;
      r.stamp = "WAIT";
      r.holdUntilDay = day + 30;
      r.heldCost = r.nowCost;
      r.nowCost = 0;
      r.reasons.unshift(`Over the family's ${usd(opts.budget)} budget for now: a nice-to-have, so it waits a month`);
      deferred.add(r);
    }
  }
  // Family budget = the money set aside for phones over the whole plan (it may stretch over years), so it
  // covers what's bought now AND what's held for later (nice-to-haves pushed to next month aside). Over it?
  // Try again with flagships trimmed to the mid-tier model where that still covers how the person uses a phone.
  const planned = sum((r) => r.nowCost + (deferred.has(r) ? 0 : r.heldCost));
  if (opts.budget !== undefined && planned > opts.budget && !opts.trimForBudget) {
    return runTrial(world, cart, day, { ...opts, trimForBudget: true });
  }
  const now = sum((r) => r.nowCost);
  return {
    day,
    rulings,
    before: sum((r) => r.originalCost),
    now,
    held: sum((r) => r.heldCost),
    savings: sum((r) => r.savings),
    planned: sum((r) => r.nowCost + r.heldCost),
    budget: opts.budget,
    overBudget: opts.budget !== undefined && sum((r) => r.nowCost + r.heldCost) > opts.budget,
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
  const planned = sum((r) => r.nowCost + r.heldCost);
  return {
    day,
    rulings,
    before: sum((r) => r.originalCost),
    now: sum((r) => r.nowCost),
    held: sum((r) => r.heldCost),
    savings: sum((r) => r.savings),
    planned,
    budget: opts.budget,
    overBudget: opts.budget !== undefined && planned > opts.budget,
  };
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
  // "My battery is at 76%" is evidence about the old phone (a battery-health report), not a wish for long battery life.
  const healthReport = /\b\d{2,3}\s*%|battery health|max(imum)? capacity/.test(t);
  if (/\b(battery|lasts? (all|the whole) day|dies|charging|charge)\b/.test(t) && !healthReport) p.battery = true;
  // Not "max" / "plus" / "ultra" on their own: "everyone has the Pro Max" names a phone, it isn't asking for a big screen.
  if (/\b(big(ger)?|large(r)?|huge) (screen|display|phone)\b|\bscreen size\b/.test(t)) p.bigScreen = true;
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

/** "what iphone 18 should I get" -> "iphone 18": a model line someone named, beyond just the brand. */
export function modelAsked(text: string): string | undefined {
  const m = text.toLowerCase().match(/\b(iphone|pixel|galaxy)\s+(\d{1,2}[a-z]?|air|s\d{2}|a\d{2})\b(?:\s+(pro max|pro xl|pro|ultra|plus|max|fe))?/);
  return m ? m.slice(1).filter(Boolean).join(" ") : undefined;
}

/** Words of the phone's name they didn't say ("iphone 18" vs iPhone 18 Pro -> ["pro"]); brand words don't count. */
export function missingWords(p: Phone, query: string): string[] {
  const asked = norm(query).split(" ");
  return norm(p.name).split(" ").filter((w) => !asked.includes(w) && !/^(iphone|pixel|galaxy|apple|google|samsung|5g)$/.test(w));
}

/** Catalog phones in the line someone named ("iphone 18" -> 18 Pro, 18 Pro Max). */
export function modelLine(world: World, model: string): Phone[] {
  const want = norm(model).split(" ");
  return world.catalog.phones.filter((p) => want.every((w) => norm(p.name).split(" ").includes(w)));
}

/** Matchmaker: best phones for how this person uses a phone, plus anything they told the court they want. */
export function recommend(world: World, memberId: string, opts: { budget?: number; prefs?: Prefs; model?: string; limit?: number } = {}): Recommendation[] {
  const m = member(world, memberId);
  const line = new Set(opts.model ? modelLine(world, opts.model).map((p) => p.id) : []);
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
      // The model they named comes first, whatever else scores well.
      if (line.has(p.id)) {
        score += 1000;
        why.unshift(`the ${opts.model!.replace(/\b(iphone|pixel|galaxy)\b/, (b) => ({ iphone: "iPhone", pixel: "Pixel", galaxy: "Galaxy" })[b]!)} you asked about`);
      }

      if (p.simple) why.unshift("Big buttons and simple mode");
      why.push(`${gb}GB fits ${m.device.storageUsedGB}GB of use with room to grow`);
      if (!prefs.battery) why.push(`${p.batteryHours}h battery`);
      if (!prefs.camera && p.camera >= m.usage.camera) why.push(`camera ${p.camera}/5 covers ${m.name.split(/\s+/)[0]}'s ${m.usage.camera}/5 use`);
      return { phoneId: p.id, name: p.name, storageGB: gb, price, why, score };
    })
    .sort((a, b) => b.score - a.score)
    // With a budget, only show over-budget phones if fewer than two fit.
    .filter((r, _i, all) => !budget || r.price <= budget || all.filter((x) => x.price <= budget).length < 2)
    .slice(0, opts.limit ?? 3)
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

// ---------------------------------------------------------------- accessories

const ACCESSORY_TYPE_WORDS: [Accessory["type"], RegExp][] = [
  ["case", /\bcases?\b/i],
  ["screen", /\b(screen protector|protector|glass)\b/i],
  ["charger", /\b(charger|charging|magsafe)\b/i],
  ["battery", /\b(power ?bank|battery pack|portable charger)\b/i],
  ["earbuds", /\b(earbuds|airpods|buds|headphones|earphones)\b/i],
];

/** "a case", "airpods", "screen protector" -> accessory type (undefined if none mentioned). */
export function accessoryType(text: string): Accessory["type"] | undefined {
  return ACCESSORY_TYPE_WORDS.find(([, re]) => re.test(text))?.[0];
}

// Where to buy it yourself: the maker's own store first (the catalog price comes from there), then T-Mobile
// (the family's carrier), Best Buy and Amazon. Real product pages when the catalog has them (with that store's
// price), otherwise a search on that store for the exact name.
const MAKER_STORES: Record<string, { store: string; search: (q: string) => string }> = {
  Apple: { store: "Apple", search: (q) => `https://www.apple.com/us/search/${encodeURIComponent(q.toLowerCase().replace(/\s+/g, "-"))}?src=globalnav` },
  Samsung: { store: "Samsung", search: (q) => `https://www.samsung.com/us/search/searchMain/?listType=g&searchTerm=${encodeURIComponent(q)}` },
  Google: { store: "Google Store", search: (q) => `https://store.google.com/us/search?q=${encodeURIComponent(q)}` },
};
const STORE_SEARCH: Record<string, (q: string) => string> = {
  "T-Mobile": (q) => `https://www.t-mobile.com/search?q=${encodeURIComponent(q)}`,
  "Best Buy": (q) => `https://www.bestbuy.com/site/searchpage.jsp?st=${encodeURIComponent(q)}`,
  Amazon: (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
};
const RETAILERS = ["T-Mobile", "Best Buy", "Amazon"];

/**
 * Store links in order: maker, T-Mobile, Best Buy, Amazon, then any other store the catalog lists.
 * `buy` is the catalog's checked links; `search` says which retailers get a search link when the catalog
 * has no page there (default: all of them when the catalog has no links at all, none when it does).
 */
export function shopLinks(name: string, brands: string[] = [], opts: { buy?: StoreLink[]; search?: string[] } = {}): StoreLink[] {
  const known = opts.buy ?? [];
  const search = opts.search ?? (known.length ? [] : RETAILERS);
  const maker = brands.length === 1 ? MAKER_STORES[brands[0]] : undefined;
  const out: StoreLink[] = [];
  const own = known.find((l) => !RETAILERS.includes(l.store));
  if (own) out.push(own);
  else if (maker) out.push({ store: maker.store, url: maker.search(name) });
  for (const store of RETAILERS) {
    const hit = known.find((l) => l.store === store);
    if (hit) out.push(hit);
    else if (search.includes(store)) out.push({ store, url: STORE_SEARCH[store](name) });
  }
  return [...out, ...known.filter((l) => !out.includes(l))];
}

/** "amazon.com" -> "Amazon": the store a pasted link is from. */
export function storeName(url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^(www|m|smile)\./, "");
  } catch {
    return "that store";
  }
  const KNOWN: [RegExp, string][] = [
    [/(^|\.)amazon\.|(^|\.)amzn\.(to|com)$|^a\.co$/, "Amazon"], [/bestbuy\./, "Best Buy"], [/walmart\./, "Walmart"], [/target\.com$/, "Target"],
    [/costco\./, "Costco"], [/t-mobile\.com$/, "T-Mobile"], [/apple\.com$/, "Apple"], [/store\.google\.com$/, "Google Store"], [/samsung\.com$/, "Samsung"],
    [/ebay\./, "eBay"], [/homedepot\./, "Home Depot"], [/lowes\./, "Lowe's"], [/wayfair\./, "Wayfair"], [/ikea\./, "IKEA"], [/etsy\./, "Etsy"],
  ];
  return KNOWN.find(([re]) => re.test(host))?.[1] ?? host;
}

/** A readable name from a store link's path ("/Levoit-Air-Purifier-Bedroom/dp/B07…" -> "Levoit Air Purifier Bedroom"), if it has one. */
export function nameFromLink(url: string): string | undefined {
  let path = "";
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return undefined;
  }
  const words = (seg: string) => seg.replace(/\.(html?|aspx?|php|p)$/i, "").split(/[-_+\s]+/).filter((w) => /[a-z]/i.test(w) && !/^\d+$/.test(w));
  const best = path.split("/")
    .filter((seg) => !/^(dp|gp|p|ip|product|products|site|shop|buy|item|en-us|us|s)$/i.test(seg) && !/^[A-Z0-9]{8,}$/.test(seg))
    .map(words)
    .filter((w) => w.length >= 2)
    .sort((x, y) => y.length - x.length)[0];
  if (!best) return undefined;
  return best.slice(0, 6).map((w) => (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}

/** Where each thing in the cart can be bought (maker first), for the case file. */
export function cartLinks(world: World, i: CartItem): StoreLink[] | undefined {
  if (i.kind === "device") {
    const p = world.catalog.phones.find((x) => x.id === i.phoneId);
    return p && shopLinks(p.name, [p.brand], { buy: p.buy });
  }
  if (i.kind === "accessory") {
    const a = (world.catalog.accessories ?? []).find((x) => x.id === i.accessoryId);
    return a && accessoryLinks(a);
  }
  if (i.kind === "product") {
    const p = i.productId ? (world.catalog.products ?? []).find((x) => x.id === i.productId) : undefined;
    if (p) return shopLinks(p.name, [p.brand], { buy: p.buy });
    if (!i.custom) return undefined;
    // The page they pasted first (where they found it), then a search at the big stores to compare.
    const pasted = i.url ? [{ store: storeName(i.url), url: i.url, price: i.custom.price }] : [];
    const others = shopLinks(i.custom.name, [], { search: ["Best Buy", "Amazon"] }).filter((l) => l.store !== pasted[0]?.store);
    return [...pasted, ...others];
  }
  return undefined;
}

const accessoryLinks = (a: Accessory) => shopLinks(a.name, a.brands, { buy: a.buy ?? (a.url ? [{ store: storeName(a.url), url: a.url }] : undefined) });

export function shopUrl(a: Accessory) {
  return accessoryLinks(a)[0].url;
}

/** Loose name match against the accessory catalog ("airpods", "rugged case", "magsafe"). */
export function findAccessory(world: World, query: string): Accessory | undefined {
  const q = query.toLowerCase().replace(/[^a-z0-9 ]+/g, " ");
  const words = q.split(/\s+/).filter((w) => w.length > 2);
  const scored = (world.catalog.accessories ?? []).map((a) => {
    const name = a.name.toLowerCase().replace(/[^a-z0-9 ]+/g, " ");
    return { a, score: words.filter((w) => name.includes(w)).length };
  });
  const best = scored.sort((x, y) => y.score - x.score)[0];
  return best && best.score > 0 ? best.a : undefined;
}

/** Brand of the phone someone will be using: the one in the cart, else their current phone. */
export function phoneBrandFor(world: World, memberId: string, cart: CartItem[] = []): string {
  const inCart = cart.find((i) => i.kind === "device" && i.memberId === memberId && i.phoneId);
  if (inCart) return phone(world, inCart.phoneId!).brand;
  const model = member(world, memberId).device.model.toLowerCase();
  return /iphone/.test(model) ? "Apple" : /pixel/.test(model) ? "Google" : /galaxy|samsung/.test(model) ? "Samsung" : "any";
}

const fits = (a: Accessory, brand: string) => a.brands.includes("any") || brand === "any" || a.brands.includes(brand);

/** Accessory picks for someone's phone: one type ("a case"), or the essentials (case, screen, charger). */
export function recommendAccessories(world: World, memberId: string, opts: { type?: Accessory["type"]; cart?: CartItem[] } = {}) {
  const m = member(world, memberId);
  const brand = phoneBrandFor(world, memberId, opts.cart);
  const young = m.age < 20 || ["teen", "kid"].includes(m.role);
  const pool = (world.catalog.accessories ?? []).filter((a) => fits(a, brand) && (!opts.type || a.type === opts.type));
  const rank = (a: Accessory) =>
    (a.brands.includes(brand) ? 0 : 1) * 1000 + // made for their phone first
    (a.id === "rugged-case" && young ? -2000 : 0) + // teens: the drop-proof case
    a.price;
  const sorted = pool.sort((x, y) => rank(x) - rank(y));
  const picks = opts.type ? sorted.slice(0, 3) : (["case", "screen", "charger"] as const).map((t) => sorted.find((a) => a.type === t)).filter(Boolean) as Accessory[];
  return picks.map((a) => ({
    accessoryId: a.id,
    name: a.name,
    type: a.type,
    price: a.price,
    shopUrl: shopUrl(a),
    shopLinks: accessoryLinks(a),
    why: [a.note ??(a.brands.includes(brand) ? `made for ${({ Apple: "iPhone", Google: "Pixel phones", Samsung: "Galaxy phones" } as Record<string, string>)[brand] ?? "your phone"}` : "works with any phone")],
  }));
}

function reviewAccessory(world: World, item: CartItem, cart: CartItem[]): Ruling {
  const m = member(world, item.memberId);
  const a = (world.catalog.accessories ?? []).find((x) => x.id === item.accessoryId);
  if (!a) throw new Error(`Unknown accessory "${item.accessoryId}"`);
  const brand = phoneBrandFor(world, m.id, cart);
  const label = `${m.name} · ${a.name}`;
  if ((a.type === "case" || a.type === "charger") && !fits(a, brand)) {
    return { itemId: item.id, memberId: m.id, label, stamp: "CUT", reasons: [`Doesn't fit ${m.name.split(/\s+/)[0]}'s ${brand} phone`], originalCost: a.price, nowCost: 0, heldCost: 0, savings: a.price };
  }
  const sameType = cart.filter((i) => i.kind === "accessory" && i.memberId === m.id && (world.catalog.accessories ?? []).find((x) => x.id === i.accessoryId)?.type === a.type);
  if (sameType.length > 1 && sameType[0].id !== item.id) {
    return { itemId: item.id, memberId: m.id, label, stamp: "CUT", reasons: [`Already getting a ${a.type === "screen" ? "screen protector" : a.type}`], originalCost: a.price, nowCost: 0, heldCost: 0, savings: a.price };
  }
  return { itemId: item.id, memberId: m.id, label, stamp: "KEEP", reasons: [a.note ? `Worth it: ${a.note}` : `Fits ${m.name.split(/\s+/)[0]}'s ${brand === "Apple" ? "iPhone" : brand + " phone"}`], originalCost: a.price, nowCost: a.price, heldCost: 0, savings: 0 };
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
  const { active, upcoming } = promoFor(world, id, day, { category, sticker: unit });
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
