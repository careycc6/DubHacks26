// The pricing engine. Deterministic and LLM-free: every number the agent says comes from here.
import type {
  CartItem, Member, NestRuling, Phone, Promo, Recommendation, Ruling, Trial, World,
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

function overkill(p: Phone, m: Member) {
  return p.tier === "flagship" && m.usage.camera <= 3 && m.usage.gaming <= 2;
}

export interface TrialOptions {
  /** Someone privately told the court money is tight. Shapes rulings; never revealed. */
  tightBudget?: boolean;
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
  if (overkill(picked, m)) {
    const mid = world.catalog.phones.find((p) => p.brand === picked.brand && p.tier === "mid");
    if (mid) {
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
  };
}

function reviewAddon(world: World, item: CartItem): Ruling {
  const addon = world.catalog.addons.find((a) => a.id === item.addonId);
  if (!addon) throw new Error(`Unknown add-on "${item.addonId}"`);
  const m = member(world, item.memberId);
  const yearly = addon.monthly * 12;
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
  const rulings = cart.map((item) => (item.kind === "device" ? reviewDevice(world, item, day, opts) : reviewAddon(world, item)));
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
  return {
    day,
    rulings,
    before: sum((r) => r.originalCost),
    now: sum((r) => r.nowCost),
    held: sum((r) => r.heldCost),
    savings: sum((r) => r.savings),
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
  return (trial?.rulings ?? []).filter((r) => r.stamp === "WAIT" && (r.holdUntilDay ?? Infinity) <= day);
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
export function recommend(world: World, memberId: string, opts: { budget?: number } = {}): Recommendation[] {
  const m = member(world, memberId);
  const wantsSimple = m.age >= 70;
  return world.catalog.phones
    .map((p) => {
      const gb = neededStorage(p, m);
      const price = p.prices[String(gb)];
      let score = 100;
      score -= 15 * Math.max(0, m.usage.camera - p.camera);
      score -= 15 * Math.max(0, m.usage.gaming - p.gaming);
      score -= 5 * Math.max(0, p.camera - m.usage.camera - 1); // paying for camera you won't use
      score -= price / 50;
      if (p.simple) score += wantsSimple ? 40 : -60;
      if (opts.budget && price > opts.budget) score -= 50;
      const why = [
        `${gb}GB fits ${m.device.storageUsedGB}GB of use with room to grow`,
        `${p.batteryHours}h battery`,
      ];
      if (p.simple) why.unshift("Big buttons and simple mode");
      if (p.camera >= m.usage.camera) why.push(`camera ${p.camera}/5 covers ${m.name}'s ${m.usage.camera}/5 use`);
      return { phoneId: p.id, name: p.name, storageGB: gb, price, why, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ score: _score, ...r }) => r);
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
