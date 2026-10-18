// The pricing engine. Deterministic and LLM-free: every number the agent says comes from here.
import type {
  Accessory, CartItem, Member, NestRuling, Phone, Promo, Recommendation, Ruling, Trial, World,
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

/** Loose name match ("17 pro max", "pixel 10") -> catalog phone. */
export function findPhone(world: World, query: string): Phone | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const q = norm(query);
  const scored = world.catalog.phones
    .map((p) => {
      const name = norm(p.name);
      const words = name.split(" ");
      const hits = words.filter((w) => q.split(" ").includes(w)).length;
      return { p, score: q.includes(name) ? 100 + name.length : hits / words.length };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0] && scored[0].score >= 0.6 ? scored[0].p : undefined;
}

const storageOptions = (p: Phone) => Object.keys(p.prices).map(Number).sort((a, b) => a - b);

/** Smallest storage tier with 2x headroom over what the person actually uses. */
export function neededStorage(p: Phone, m: Member): number {
  const opts = storageOptions(p);
  return opts.find((gb) => gb >= m.device.storageUsedGB * 2) ?? opts[opts.length - 1];
}

const promoFor = (world: World, phoneId: string, day: number) => ({
  active: world.offers.promos.find((x) => x.phones.includes(phoneId) && x.startsOnDay <= day && day < x.endsOnDay),
  upcoming: world.offers.promos.find(
    (x) => x.phones.includes(phoneId) && x.startsOnDay > day && x.startsOnDay - day <= PROMO_LOOKAHEAD_DAYS,
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

/** Store price of a phone on a given demo day (sticker minus any promo running that day). */
export function priceOn(world: World, phoneId: string, gb: number, day: number): number {
  const p = phone(world, phoneId);
  const sticker = p.prices[String(gb)] ?? Math.min(...Object.values(p.prices));
  const promo = world.offers.promos.find((x) => x.phones.includes(phoneId) && x.startsOnDay <= day && day < x.endsOnDay);
  return sticker - (promo?.credit ?? 0);
}

export interface PriceTrack {
  points: { day: number; price: number }[];
  now: number;
  lowest: { day: number; price: number };
}

/** Price over the next `span` days, with every promo start/end as its own point, so drops show exactly. */
export function priceTrack(world: World, phoneId: string, gb: number, fromDay: number, span = 120): PriceTrack {
  const days = new Set<number>();
  for (let d = fromDay; d <= fromDay + span; d += 10) days.add(d);
  for (const x of world.offers.promos.filter((x) => x.phones.includes(phoneId))) {
    for (const d of [x.startsOnDay - 1, x.startsOnDay, x.endsOnDay - 1, x.endsOnDay]) if (d >= fromDay && d <= fromDay + span) days.add(d);
  }
  const points = [...days].sort((a, b) => a - b).map((day) => ({ day, price: priceOn(world, phoneId, gb, day) }));
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
  if ((opts.tightBudget && m.device.batteryHealth < LOW_BATTERY || opts.trimForBudget) && target === picked && picked.tier === "flagship") {
    const mid = world.catalog.phones.find((p) => p.brand === picked.brand && p.tier === "mid");
    const wants = opts.prefs?.[m.id] ?? {};
    const keepsWhatTheyWant = !!mid && !(wants.bigScreen && mid.screenIn < picked.screenIn) && !(wants.camera && mid.camera < picked.camera);
    if (mid && keepsWhatTheyWant && mid.camera >= m.usage.camera && mid.gaming >= m.usage.gaming) {
      target = mid;
      reasons.push(
        opts.trimForBudget
          ? `To fit the family's phone budget: the ${mid.name} covers how ${m.name.split(/s+/)[0]} uses a phone`
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

  // 3. Trade-in the family forgot about.
  if (m.device.tradeInValue > 0) {
    reasons.push(`Trade in ${m.name}'s ${m.device.model}: −${usd(m.device.tradeInValue)}`);
    price -= m.device.tradeInValue;
  }

  // 4. Timing: should this purchase wait?
  const { active, upcoming } = promoFor(world, target.id, day);
  if (active) {
    reasons.push(`${active.name} is live: −${usd(active.credit)}`);
    price -= active.credit;
  }
  const healthy = m.device.batteryHealth >= LOW_BATTERY;
  let holdUntilDay: number | undefined;
  if (healthy && upcoming && !active) {
    holdUntilDay = upcoming.startsOnDay;
    reasons.push(`${upcoming.name} starts in ${upcoming.startsOnDay - day} days: −${usd(upcoming.credit)}`);
    price -= upcoming.credit;
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
    };
  }
  const dupe = world.household.accountAddons.find((a) => a.id === addon.id);
  if (dupe && !dupe.usedInLast12Months) {
    return {
      itemId: item.id, memberId: m.id, label: `${m.name} · ${addon.name}`, stamp: "CUT",
      reasons: [`The account already pays for ${dupe.name} and nobody has used it in 12 months`],
      originalCost: yearly, nowCost: 0, heldCost: 0, savings: yearly,
    };
  }
  return {
    itemId: item.id, memberId: m.id, label: `${m.name} · ${addon.name}`, stamp: "KEEP",
    reasons: ["Reasonable add-on"], originalCost: yearly, nowCost: yearly, heldCost: 0, savings: 0,
  };
}

/** Put the whole cart (plus the account's dead weight) on trial. */
export function runTrial(world: World, cart: CartItem[], day: number, opts: TrialOptions = {}): Trial {
  const rulings = cart.map((item) => (item.kind === "device" ? reviewDevice(world, item, day, opts) : item.kind === "accessory" ? reviewAccessory(world, item, cart) : reviewAddon(world, item, cart)));
  for (const a of world.household.accountAddons) {
    if (a.usedInLast12Months) continue;
    const yearly = a.monthly * 12;
    rulings.push({
      itemId: `account:${a.id}`, label: `Account · ${a.name}`, stamp: "CUT",
      reasons: [`${usd(a.monthly)}/mo and unused for 12 months`],
      originalCost: yearly, nowCost: 0, heldCost: 0, savings: yearly,
    });
  }
  const sum = (f: (r: Ruling) => number) => rulings.reduce((t, r) => t + f(r), 0);

  // Protection follows its phone: if the phone waits, so does the plan.
  const holdAddonsWithPhones = () => {
    for (const r of rulings) {
      // Add-ons and accessories bought for a phone that has to wait, wait with it.
      if (r.stamp !== "KEEP" || r.proposed || !r.memberId || r.itemId.startsWith("account:")) continue;
      const phoneRuling = rulings.find((x) => x.memberId === r.memberId && x.proposed && x.stamp === "WAIT");
      if (!phoneRuling) continue;
      r.stamp = "WAIT";
      r.holdUntilDay = phoneRuling.holdUntilDay;
      r.heldCost = r.nowCost;
      r.nowCost = 0;
      r.reasons.unshift(r.label.includes("Protection") ? "Starts the day the new phone does" : "Buy it together with the new phone");
    }
  };
  holdAddonsWithPhones();

  // Family budget = the money set aside for phones over the whole plan (it may stretch over years), so it
  // covers what's bought now AND what's held for later. Over it? Try again with flagships trimmed to the
  // mid-tier model where that still covers how the person uses a phone.
  const planned = sum((r) => r.nowCost + r.heldCost);
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

export function promosFor(world: World, phoneId: string, day: number): Promo[] {
  return world.offers.promos.filter((p) => p.phones.includes(phoneId) && p.endsOnDay > day);
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

/** Where to buy it: the catalog's own link if it has one, else a shopping search for the exact name. */
export function shopUrl(a: Accessory) {
  return a.url ?? `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(a.name).replace(/%20/g, "+")}`;
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
