// src/app.ts
import "dotenv/config";
import express from "express";
import { fileURLToPath as fileURLToPath5 } from "node:url";

// src/agent.ts
import { GoogleGenAI as GoogleGenAI2 } from "@google/genai";

// src/engine.ts
var LOW_BATTERY = 80;
var BATTERY_SERVICE = 99;
var PROMO_LOOKAHEAD_DAYS = 90;
var DAYS_PER_PAYMENT = 30;
var SCREEN_REPAIR = 129;
var usd = (n) => `$${Math.round(n).toLocaleString("en-US")}`;
function member(world2, id) {
  const m = world2.household.members.find((x) => x.id === id);
  if (!m) throw new Error(`Unknown member "${id}"`);
  return m;
}
function phone(world2, id) {
  const p = world2.catalog.phones.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown phone "${id}"`);
  return p;
}
var norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function bestMatch(items, query) {
  const q = norm(query);
  const scored = items.map((item) => {
    const name = norm(item.name);
    const words = name.split(" ");
    const hits = words.filter((w) => q.split(" ").includes(w)).length;
    return { item, score: q.includes(name) ? 100 + name.length : hits / words.length };
  }).sort((a, b) => b.score - a.score);
  return scored[0] && scored[0].score >= 0.6 ? scored[0] : void 0;
}
function findPhone(world2, query) {
  return bestMatch(world2.catalog.phones, query)?.item;
}
var promoCovers = (x, id, category) => !!(x.phones?.includes(id) || x.products?.includes(id) || category && x.categories?.includes(category));
var promoCredit = (x, sticker2) => x.credit ?? Math.round(sticker2 * (x.percentOff ?? 0) / 100);
var promoText = (x, sticker2) => x.percentOff ? `${x.percentOff}% off (\u2212${usd(promoCredit(x, sticker2))})` : `\u2212${usd(promoCredit(x, sticker2))}`;
var storageOptions = (p) => Object.keys(p.prices).map(Number).sort((a, b) => a - b);
function neededStorage(p, m) {
  const opts = storageOptions(p);
  return opts.find((gb) => gb >= m.device.storageUsedGB * 2) ?? opts[opts.length - 1];
}
var BILL_CREDIT_MONTHS = 24;
var DEVICE_MONTHS = 24;
var perMonth = (price) => Math.ceil(price / DEVICE_MONTHS);
function planCost(x, currentPlan) {
  if (!x.requiresPlan || x.requiresPlan === currentPlan) return 0;
  return (x.planExtraMonthly ?? 0) * (x.billCreditMonths ?? BILL_CREDIT_MONTHS);
}
var dealValue = (x, plan, sticker2) => promoCredit(x, sticker2) - planCost(x, plan);
var qualifies = (x, sticker2, m, plan) => (!x.requiresTradeIn || !m || m.device.tradeInValue > 0) && dealValue(x, plan, sticker2) > 0;
var promoFor = (world2, id, day, opts) => {
  const plan = world2.household.plan;
  const { m, category, sticker: sticker2 } = opts;
  const mine = world2.offers.promos.filter((x) => promoCovers(x, id, category));
  const best = (xs) => xs.sort((a, b) => dealValue(b, plan, sticker2) - dealValue(a, plan, sticker2))[0];
  return {
    active: best(mine.filter((x) => x.startsOnDay <= day && day < x.endsOnDay && qualifies(x, sticker2, m, plan))),
    upcoming: best(mine.filter((x) => x.startsOnDay > day && x.startsOnDay - day <= PROMO_LOOKAHEAD_DAYS && qualifies(x, sticker2, m, plan))),
    // Deals the court turned down (a plan that costs more than it saves), so it can say why.
    notWorthIt: mine.filter((x) => x.startsOnDay <= day + PROMO_LOOKAHEAD_DAYS && day < x.endsOnDay && x.requiresPlan && !qualifies(x, sticker2, m, plan))
  };
};
function dealText(x, plan, sticker2) {
  const extra = planCost(x, plan);
  const parts = [];
  if (x.billCreditMonths) parts.push(`as ${x.billCreditMonths} monthly bill credits, so stay ${x.billCreditMonths} months to get it all`);
  if (extra) parts.push(`needs ${x.requiresPlan} at +${usd(x.planExtraMonthly ?? 0)}/mo, so ${usd(dealValue(x, plan, sticker2))} net`);
  return `${promoText(x, sticker2)}${parts.length ? ` (${parts.join("; ")})` : ""}`;
}
function overkill(p, m, prefs = {}) {
  if (prefs.camera || prefs.gaming) return false;
  return p.tier === "flagship" && m.usage.camera <= 3 && m.usage.gaming <= 2;
}
var VERDICT = {
  KEEP: { word: "BUY", hint: "good to go" },
  SWAP: { word: "BUY", hint: "a better pick" },
  WAIT: { word: "WAIT", hint: "price drops later" },
  CUT: { word: "SKIP", hint: "cancel it" },
  STAY: { word: "STAY", hint: "on the family plan" },
  LEAVE: { word: "GO SOLO", hint: "own plan" }
};
function sticker(world2, id, variant) {
  const ph = world2.catalog.phones.find((x) => x.id === id);
  if (ph) return { price: ph.prices[String(variant)] ?? Math.min(...Object.values(ph.prices)) };
  const pr = product(world2, id);
  return { price: pr.prices[String(variant)] ?? Math.min(...Object.values(pr.prices)), category: pr.category };
}
function priceOn(world2, id, variant, day, custom) {
  const { price, category } = custom ?? sticker(world2, id, variant);
  const promo = world2.offers.promos.find((x) => promoCovers(x, id, category) && x.startsOnDay <= day && day < x.endsOnDay);
  return price - (promo ? promoCredit(promo, price) : 0);
}
function priceTrack(world2, id, variant, fromDay, span = 120, custom) {
  const { category } = custom ?? sticker(world2, id, variant);
  const days = /* @__PURE__ */ new Set();
  for (let d = fromDay; d <= fromDay + span; d += 10) days.add(d);
  for (const x of world2.offers.promos.filter((x2) => promoCovers(x2, id, category))) {
    for (const d of [x.startsOnDay - 1, x.startsOnDay, x.endsOnDay - 1, x.endsOnDay]) if (d >= fromDay && d <= fromDay + span) days.add(d);
  }
  const points = [...days].sort((a, b) => a - b).map((day) => ({ day, price: priceOn(world2, id, variant, day, custom) }));
  const lowest = points.reduce((best, p) => p.price < best.price ? p : best, points[0]);
  return { points, now: points[0].price, lowest };
}
var PROTECTION_MONTHLY = 18;
function protectionAdvice(m, phonePrice) {
  const yearly = PROTECTION_MONTHLY * 12;
  const young = m.age < 20 || ["teen", "kid"].includes(m.role);
  if (phonePrice >= 800 && (young || m.device.screenCracked)) {
    return {
      verdict: "ADD",
      monthly: PROTECTION_MONTHLY,
      reason: `${m.device.screenCracked ? "Their current screen is already cracked" : "Teens drop phones"}: ${usd(PROTECTION_MONTHLY)}/mo protects a ${usd(phonePrice)} phone`
    };
  }
  if (phonePrice < 600) {
    return { verdict: "SKIP", monthly: PROTECTION_MONTHLY, reason: `Skip it: ${usd(yearly)}/yr is a lot next to a ${usd(phonePrice)} phone. A good case does the job` };
  }
  return { verdict: "OPTIONAL", monthly: PROTECTION_MONTHLY, reason: `Optional: ${usd(yearly)}/yr vs a ${usd(SCREEN_REPAIR)} screen repair if it ever breaks` };
}
function witnessStatement(m) {
  const free = Math.round(100 - m.device.storageUsedGB / m.device.storageGB * 100);
  const monthsLeft = Math.max(6, Math.round((m.device.batteryHealth - 70) * 1.2));
  return `I am ${m.name}'s ${m.device.model}. I am ${m.device.ageMonths} months old. My battery is at ${m.device.batteryHealth}% and ${free}% of my storage is still free. I have about ${monthsLeft} good months left. I'd like to be heard before I'm replaced.`;
}
var CRACKED_TRADE_IN = 0.4;
function tradeIn(m) {
  const full = m.device.tradeInValue;
  const who = `${m.name}'s ${m.device.model}`;
  if (!m.device.screenCracked || full <= 0) return { value: full, reason: `Trade in ${who}: \u2212${usd(full)}` };
  const cracked = Math.round(full * CRACKED_TRADE_IN / 5) * 5;
  const fixFirst = full - SCREEN_REPAIR;
  return fixFirst > cracked ? { value: fixFirst, reason: `Fix the screen first (${usd(SCREEN_REPAIR)}), then trade in ${who} for ${usd(full)} instead of about ${usd(cracked)} cracked: \u2212${usd(fixFirst)} after the repair` } : { value: cracked, reason: `Trade in ${who} as is: about \u2212${usd(cracked)} with the cracked screen (\u2212${usd(full)} if it weren't)` };
}
function reviewDevice(world2, item, day, opts = {}) {
  const court = judgeDevice(world2, item, day, opts);
  return item.overruledBy ? overrule(world2, item, day, court) : court;
}
function judgeDevice(world2, item, day, opts = {}) {
  const m = member(world2, item.memberId);
  const picked = phone(world2, item.phoneId);
  const pickedGB = item.storageGB ?? storageOptions(picked)[0];
  const originalCost = picked.prices[String(pickedGB)] ?? picked.prices[String(storageOptions(picked)[0])];
  const reasons2 = [];
  let target = picked;
  if (overkill(picked, m, opts.prefs?.[m.id])) {
    const mid = world2.catalog.phones.find((p) => p.brand === picked.brand && p.tier === "mid");
    const wants = opts.prefs?.[m.id] ?? {};
    const losesWhatTheyWant = !!mid && (wants.bigScreen && mid.screenIn < picked.screenIn || wants.battery && mid.batteryHours < picked.batteryHours - 1);
    if (mid && !losesWhatTheyWant) {
      target = mid;
      reasons2.push(`Pro features ${m.name} won't use (camera ${m.usage.camera}/5, gaming ${m.usage.gaming}/5), so the ${mid.name} is the better fit`);
    }
  }
  if ((opts.tightBudget && m.device.batteryHealth < LOW_BATTERY || opts.trimForBudget) && target === picked && picked.tier === "flagship") {
    const mid = world2.catalog.phones.find((p) => p.brand === picked.brand && p.tier === "mid");
    const wants = opts.prefs?.[m.id] ?? {};
    const keepsWhatTheyWant = !!mid && !(wants.bigScreen && mid.screenIn < picked.screenIn) && !(wants.camera && mid.camera < picked.camera);
    if (mid && keepsWhatTheyWant && mid.camera >= m.usage.camera && mid.gaming >= m.usage.gaming) {
      target = mid;
      reasons2.push(
        opts.trimForBudget ? `To fit the family's phone budget: the ${mid.name} covers how ${m.name.split(/\s+/)[0]} uses a phone` : `Keeping the total in check: the ${mid.name} has the ${mid.camera}/5 camera ${m.name} actually uses`
      );
    }
  }
  const myBudget = opts.prefs?.[m.id]?.budget;
  if (myBudget && target.prices[String(neededStorage(target, m))] > myBudget) {
    const fit = recommend(world2, m.id, { prefs: opts.prefs?.[m.id] }).find((r) => r.price <= myBudget);
    if (fit) {
      target = phone(world2, fit.phoneId);
      reasons2.push(`Over ${m.name.split(/\s+/)[0]}'s ${usd(myBudget)} budget: the ${target.name} fits it`);
    }
  }
  let gb = target === picked ? pickedGB : Math.min(pickedGB, neededStorage(target, m));
  if (!(String(gb) in target.prices)) gb = neededStorage(target, m);
  const need = neededStorage(target, m);
  if (gb > need) {
    reasons2.push(`${gb}GB is overkill: ${m.name} uses ${m.device.storageUsedGB}GB after ${m.device.ageMonths} months, so ${need}GB is plenty`);
    gb = need;
  }
  let price = target.prices[String(gb)];
  const math = [{ label: `${picked.name} ${pickedGB}GB, as argued`, amount: originalCost }];
  if (price !== originalCost) math.push({ label: target.id !== picked.id ? `Switch to ${target.name} ${gb}GB` : `Drop to ${gb}GB`, amount: price - originalCost });
  const plan = world2.household.plan;
  const ti = tradeIn(m);
  if (ti.value > 0) {
    reasons2.push(ti.reason);
    price -= ti.value;
    math.push({ label: `Trade-in: ${m.device.model}${m.device.screenCracked ? " (cracked screen)" : ""}`, amount: -ti.value });
  }
  const { active, upcoming, notWorthIt } = promoFor(world2, target.id, day, { m, sticker: target.prices[String(gb)] });
  let tradeInDeal = 0;
  if (active) {
    const off = dealValue(active, plan, target.prices[String(gb)]);
    reasons2.push(`${active.name} is live: ${dealText(active, plan, target.prices[String(gb)])}`);
    price -= off;
    math.push({ label: `${active.name} (live now)`, amount: -off });
    if (active.requiresTradeIn) tradeInDeal = off;
  }
  const healthy = m.device.batteryHealth >= LOW_BATTERY;
  let holdUntilDay;
  if (healthy && upcoming && !active) {
    holdUntilDay = upcoming.startsOnDay;
    const off = dealValue(upcoming, plan, target.prices[String(gb)]);
    reasons2.push(`${upcoming.name} starts in ${upcoming.startsOnDay - day} days: ${dealText(upcoming, plan, target.prices[String(gb)])}`);
    price -= off;
    math.push({ label: `${upcoming.name} (from day ${upcoming.startsOnDay})`, amount: -off });
    if (upcoming.requiresTradeIn) tradeInDeal = off;
  }
  for (const x of notWorthIt.filter((x2) => x2 !== active && x2 !== upcoming)) {
    reasons2.push(`Skip the ${x.name}: it needs ${x.requiresPlan} at +${usd(x.planExtraMonthly ?? 0)}/mo, which costs ${usd(planCost(x, plan))} over ${x.billCreditMonths ?? BILL_CREDIT_MONTHS} months for a ${usd(promoCredit(x, target.prices[String(gb)]))} credit`);
  }
  const paymentsLeft = Math.max(0, Math.ceil((m.device.installmentsLeft * DAYS_PER_PAYMENT - day) / DAYS_PER_PAYMENT));
  if (healthy && paymentsLeft > 0) {
    holdUntilDay = Math.max(holdUntilDay ?? 0, m.device.installmentsLeft * DAYS_PER_PAYMENT);
    reasons2.push(`${paymentsLeft} payments (${usd(paymentsLeft * m.device.monthlyInstallment)}) left on the ${m.device.model}. Upgrading now means paying it off early`);
  }
  if (holdUntilDay !== void 0) {
    reasons2.unshift(`${m.name}'s ${m.device.model} still has ${m.device.batteryHealth}% battery health. It has time left`);
  } else if (!healthy) {
    reasons2.unshift(`${m.name}'s ${m.device.model} is at ${m.device.batteryHealth}% battery health. Upgrading now makes sense`);
    if (!m.device.screenCracked && m.device.ageMonths <= 48) reasons2.splice(1, 0, `Or consider a battery replacement (about ${usd(BATTERY_SERVICE)}): it can give the ${m.device.model} another year or two`);
  }
  const repairNow = holdUntilDay !== void 0 && !!m.device.screenCracked;
  if (repairNow && ti.value < m.device.tradeInValue) {
    price -= m.device.tradeInValue - ti.value;
    reasons2[reasons2.indexOf(ti.reason)] = `Trade in ${m.name}'s ${m.device.model} once it's repaired: \u2212${usd(m.device.tradeInValue)}`;
    const line = math.find((l) => l.label.startsWith("Trade-in:"));
    if (line) Object.assign(line, { label: `Trade-in: ${m.device.model} (repaired first)`, amount: -m.device.tradeInValue });
    ti.value = m.device.tradeInValue;
  }
  if (repairNow) reasons2.splice(1, 0, `The evidence shows a cracked screen. A ${usd(SCREEN_REPAIR)} screen repair fixes that today. A new phone doesn't have to`);
  else if (m.device.screenCracked) reasons2.splice(1, 0, "The evidence shows a cracked screen too");
  const changed2 = target.id !== picked.id || gb !== pickedGB;
  const stamp = holdUntilDay !== void 0 ? "WAIT" : changed2 ? "SWAP" : "KEEP";
  const waitSavings = holdUntilDay !== void 0 ? paymentsLeft * m.device.monthlyInstallment : 0;
  return {
    itemId: item.id,
    memberId: m.id,
    label: `${m.name} \xB7 ${picked.name} ${pickedGB}GB`,
    stamp,
    reasons: reasons2,
    originalCost,
    nowCost: stamp === "WAIT" ? repairNow ? SCREEN_REPAIR : 0 : price,
    heldCost: stamp === "WAIT" ? price : 0,
    savings: originalCost - price + waitSavings - (repairNow ? SCREEN_REPAIR : 0),
    holdUntilDay,
    proposed: { phoneId: target.id, storageGB: gb, label: `${target.name} ${gb}GB` },
    witness: stamp === "WAIT" ? witnessStatement(m) : void 0,
    witnessOf: stamp === "WAIT" ? `${m.name}'s current phone` : void 0,
    urgent: !healthy || !!m.device.screenCracked,
    math,
    protection: protectionAdvice(m, target.prices[String(gb)]),
    tradeIn: ti.value > 0 ? { device: m.device.model, value: ti.value, withTradeIn: price, withoutTradeIn: price + ti.value + tradeInDeal } : void 0,
    track: priceTrack(world2, target.id, gb, day, Math.max(90, (holdUntilDay ?? day) - day + 40))
  };
}
function overrule(world2, item, day, court) {
  const m = member(world2, item.memberId);
  const by = world2.household.members.find((x) => x.id === item.overruledBy)?.name ?? "a parent";
  const picked = phone(world2, item.phoneId);
  const gb = item.storageGB ?? storageOptions(picked)[0];
  const sticker2 = picked.prices[String(gb)] ?? court.originalCost;
  const plan = world2.household.plan;
  const first4 = m.name.split(/\s+/)[0];
  const reasons2 = [`${by.split(/\s+/)[0]}'s call: ${first4} gets it today, as picked`];
  let price = sticker2;
  const math = [{ label: `${picked.name} ${gb}GB, as picked`, amount: sticker2 }];
  const ti = tradeIn(m);
  if (ti.value > 0) {
    reasons2.push(ti.reason);
    price -= ti.value;
    math.push({ label: `Trade-in: ${m.device.model}${m.device.screenCracked ? " (cracked screen)" : ""}`, amount: -ti.value });
  }
  const { active } = promoFor(world2, picked.id, day, { m, sticker: sticker2 });
  if (active) {
    const off = dealValue(active, plan, sticker2);
    reasons2.push(`${active.name} is live: ${dealText(active, plan, sticker2)}`);
    price -= off;
    math.push({ label: `${active.name} (live now)`, amount: -off });
  }
  const paymentsLeft = Math.max(0, Math.ceil((m.device.installmentsLeft * DAYS_PER_PAYMENT - day) / DAYS_PER_PAYMENT));
  if (paymentsLeft > 0) reasons2.push(`Pays off the last ${paymentsLeft} payments on the ${m.device.model} (${usd(paymentsLeft * m.device.monthlyInstallment)}) early`);
  const savings = sticker2 - price;
  const extra = Math.max(0, court.savings - savings);
  const courtPlan = court.stamp === "WAIT" ? `${court.proposed?.label ?? picked.name} for ${usd(court.heldCost)} on day ${court.holdUntilDay}` : `${court.proposed?.label ?? picked.name} for ${usd(court.nowCost)} today`;
  if (extra > 0) reasons2.push(`For the record: the court's plan was the ${courtPlan}. This costs ${usd(extra)} more`);
  return {
    ...court,
    stamp: "KEEP",
    reasons: reasons2,
    originalCost: sticker2,
    nowCost: price,
    heldCost: 0,
    savings,
    holdUntilDay: void 0,
    proposed: { phoneId: picked.id, storageGB: gb, label: `${picked.name} ${gb}GB` },
    witness: void 0,
    protection: protectionAdvice(m, sticker2),
    tradeIn: ti.value > 0 ? { device: m.device.model, value: ti.value, withTradeIn: price, withoutTradeIn: price + ti.value } : void 0,
    track: priceTrack(world2, picked.id, gb, day, 90),
    math,
    overruled: { by, courtPlan, extra }
  };
}
function whatWouldChange(world2, cart, itemId, day, opts = {}) {
  const item = cart.find((i) => i.id === itemId);
  if (!item || item.kind !== "device" || item.overruledBy) return [];
  const now = judgeDevice(world2, item, day, opts);
  if (now.stamp === "KEEP") return [];
  const m = member(world2, item.memberId);
  const hints = [];
  const tryWith = (edit, o = opts) => {
    const w = structuredClone(world2);
    edit(w);
    return judgeDevice(w, item, day, o);
  };
  if (now.stamp === "WAIT" && m.device.batteryHealth >= LOW_BATTERY && !tryWith((w) => member(w, m.id).device.batteryHealth = LOW_BATTERY - 1).holdUntilDay) {
    hints.push(`Battery Health under ${LOW_BATTERY}%: send a screenshot (Settings \u2192 Battery)`);
  }
  if (now.proposed && now.proposed.phoneId !== item.phoneId) {
    const prefs = opts.prefs?.[m.id] ?? {};
    for (const [want, words] of [["camera", "you'll really use the Pro camera"], ["gaming", "you play demanding games"]]) {
      if (prefs[want]) continue;
      const r = tryWith(() => {
      }, { ...opts, prefs: { ...opts.prefs, [m.id]: { ...prefs, [want]: true } } });
      if (r.proposed?.phoneId === item.phoneId) {
        hints.push(`Tell the court ${words} (e.g. "I shoot video for school")`);
        break;
      }
    }
  }
  return hints;
}
function reviewAddon(world2, item, cart = []) {
  const addon = world2.catalog.addons.find((a) => a.id === item.addonId);
  if (!addon) throw new Error(`Unknown add-on "${item.addonId}"`);
  const m = member(world2, item.memberId);
  const yearly = addon.monthly * 12;
  const device = cart.find((c) => c.kind === "device" && c.memberId === m.id);
  if (addon.id === "protection-360" && device?.phoneId) {
    const p = phone(world2, device.phoneId);
    const advice = protectionAdvice(m, p.prices[String(device.storageGB)] ?? Math.min(...Object.values(p.prices)));
    const keep = advice.verdict !== "SKIP";
    return {
      itemId: item.id,
      memberId: m.id,
      label: `${m.name} \xB7 ${addon.name}`,
      stamp: keep ? "KEEP" : "CUT",
      reasons: [advice.reason],
      originalCost: yearly,
      nowCost: keep ? yearly : 0,
      heldCost: 0,
      savings: keep ? 0 : yearly,
      math: [{ label: `${addon.name}: 12 \xD7 ${usd(addon.monthly)}`, amount: yearly }, ...keep ? [] : [{ label: "Struck: not worth it for this phone", amount: -yearly }]]
    };
  }
  const dupe = world2.household.accountAddons.find((a) => a.id === addon.id);
  if (dupe && !dupe.usedInLast12Months) {
    return {
      itemId: item.id,
      memberId: m.id,
      label: `${m.name} \xB7 ${addon.name}`,
      stamp: "CUT",
      reasons: [`The account already pays for ${dupe.name} and nobody has used it in 12 months`],
      originalCost: yearly,
      nowCost: 0,
      heldCost: 0,
      savings: yearly,
      math: [{ label: `${addon.name}: 12 \xD7 ${usd(addon.monthly)}`, amount: yearly }, { label: "Struck: already on the account, unused", amount: -yearly }]
    };
  }
  return {
    itemId: item.id,
    memberId: m.id,
    label: `${m.name} \xB7 ${addon.name}`,
    stamp: "KEEP",
    reasons: ["Reasonable add-on"],
    originalCost: yearly,
    nowCost: yearly,
    heldCost: 0,
    savings: 0,
    math: [{ label: `${addon.name}: 12 \xD7 ${usd(addon.monthly)}`, amount: yearly }]
  };
}
var HAND_ME_DOWN_BATTERY = 85;
function priceHandMeDowns(world2, rulings, day) {
  const phones = rulings.filter((r) => r.proposed && r.memberId && r.stamp !== "CUT");
  for (const r of phones) {
    const kid = member(world2, r.memberId);
    if (!["teen", "kid"].includes(kid.role)) continue;
    const best = phones.filter((g) => g !== r).map((g) => ({ g, m: member(world2, g.memberId) })).filter(({ m }) => ["parent", "partner"].includes(m.role) && !m.device.screenCracked && m.device.batteryHealth >= HAND_ME_DOWN_BATTERY && m.device.ageMonths < kid.device.ageMonths).map(({ g, m }) => ({ g, m, forgone: g.tradeIn ? g.tradeIn.withoutTradeIn - g.tradeIn.withTradeIn : m.device.tradeInValue })).sort((a, b) => a.forgone - b.forgone)[0];
    if (!best) continue;
    const instead = r.stamp === "WAIT" ? r.heldCost : r.nowCost;
    r.handMeDown = {
      from: best.m.id,
      device: best.m.device.model,
      batteryHealth: best.m.device.batteryHealth,
      onDay: best.g.stamp === "WAIT" ? best.g.holdUntilDay ?? day : day,
      forgone: best.forgone,
      instead,
      saves: instead - best.forgone
    };
  }
}
function handMeDownText(world2, r) {
  const h = r.handMeDown;
  if (!h) return void 0;
  const giver = member(world2, h.from).name.split(/\s+/)[0];
  const kid = member(world2, r.memberId).name.split(/\s+/)[0];
  return h.saves > 0 ? `Hand-me-down option: ${kid} takes ${giver}'s ${h.device} (${h.batteryHealth}% battery) on day ${h.onDay}. It costs the ${usd(h.forgone)} trade-in, but skips a ${usd(h.instead)} phone: ${usd(h.saves)} less` : `Checked a hand-me-down: ${giver}'s ${h.device} to ${kid} would cost ${usd(-h.saves)} more than trading it in (${usd(h.forgone)} in trade-in and deals vs a ${usd(h.instead)} phone)`;
}
function runTrial(world2, cart, day, opts = {}) {
  const rulings = cart.map((item) => item.kind === "device" ? reviewDevice(world2, item, day, opts) : item.kind === "product" ? reviewProduct(world2, item, day, opts, cart) : item.kind === "accessory" ? reviewAccessory(world2, item, cart) : reviewAddon(world2, item, cart));
  for (const a of world2.household.accountAddons) {
    if (a.usedInLast12Months) continue;
    const yearly = a.monthly * 12;
    rulings.push({
      itemId: `account:${a.id}`,
      label: `Account \xB7 ${a.name}`,
      stamp: "CUT",
      reasons: [`${usd(a.monthly)}/mo and unused for 12 months`],
      originalCost: yearly,
      nowCost: 0,
      heldCost: 0,
      savings: yearly,
      math: [{ label: `${a.name}: 12 \xD7 ${usd(a.monthly)}`, amount: yearly }, { label: "Struck: unused for 12 months", amount: -yearly }]
    });
  }
  const sum = (f) => rulings.reduce((t, r) => t + f(r), 0);
  const holdAddonsWithPhones = () => {
    for (const r of rulings) {
      if (r.stamp !== "KEEP" || r.proposed || !r.memberId || r.itemId.startsWith("account:")) continue;
      const phoneRuling2 = rulings.find((x) => x.memberId === r.memberId && x.proposed?.phoneId && x.stamp === "WAIT");
      if (!phoneRuling2) continue;
      r.stamp = "WAIT";
      r.holdUntilDay = phoneRuling2.holdUntilDay;
      r.heldCost = r.nowCost;
      r.nowCost = 0;
      r.reasons.unshift(r.label.includes("Protection") ? "Starts the day the new phone does" : "Buy it together with the new phone");
    }
  };
  holdAddonsWithPhones();
  priceHandMeDowns(world2, rulings, day);
  const deferred = /* @__PURE__ */ new Set();
  if (opts.budget !== void 0 && sum((r) => r.nowCost) > opts.budget) {
    const extras = rulings.filter((r) => (r.stamp === "KEEP" || r.stamp === "SWAP") && r.proposed?.productId !== void 0 && !r.urgent).sort((a, b) => b.nowCost - a.nowCost);
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
  const planned = sum((r) => r.nowCost + (deferred.has(r) ? 0 : r.heldCost));
  if (opts.budget !== void 0 && planned > opts.budget && !opts.trimForBudget) {
    return runTrial(world2, cart, day, { ...opts, trimForBudget: true });
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
    overBudget: opts.budget !== void 0 && sum((r) => r.nowCost + r.heldCost) > opts.budget
  };
}
function advanceTrial(world2, cart, old, day, opts = {}) {
  if (!old) return void 0;
  const fresh2 = runTrial(world2, cart, day, opts);
  const rulings = fresh2.rulings.map((r) => {
    const prev = old.rulings.find((p) => p.itemId === r.itemId);
    const stillHeld = prev?.stamp === "WAIT" && (prev.holdUntilDay ?? 0) > day;
    return prev && (prev.stamp !== "WAIT" || stillHeld) ? prev : r;
  });
  const sum = (f) => rulings.reduce((t, r) => t + f(r), 0);
  return { day, rulings, before: sum((r) => r.originalCost), now: sum((r) => r.nowCost), held: sum((r) => r.heldCost), savings: sum((r) => r.savings) };
}
function readyHolds(trial, day) {
  return (trial?.rulings ?? []).filter((r) => r.stamp === "WAIT" && !!r.proposed && (r.holdUntilDay ?? Infinity) <= day);
}
function leavingNest(world2, memberId) {
  const m = member(world2, memberId);
  const byLines = world2.offers.familyPlan.totalMonthlyByLines;
  const n = world2.household.members.length;
  const familyLineMonthly = byLines[String(n)] - byLines[String(n - 1)];
  const solo = [...world2.offers.soloPlans].filter((p) => p.dataGB >= m.usage.dataGBPerMonth).sort((a, b) => a.monthly - b.monthly)[0] ?? world2.offers.soloPlans[0];
  const stay = familyLineMonthly <= solo.monthly;
  return {
    memberId,
    stamp: stay ? "STAY" : "LEAVE",
    familyLineMonthly,
    soloPlan: { name: solo.name, monthly: solo.monthly },
    monthlySavings: Math.abs(solo.monthly - familyLineMonthly),
    reasons: stay ? [
      `${m.name}'s line costs the family ${usd(familyLineMonthly)}/mo. The cheapest solo plan that fits ${m.usage.dataGBPerMonth}GB/mo is ${solo.name} at ${usd(solo.monthly)}/mo`,
      `Staying saves ${usd(solo.monthly - familyLineMonthly)}/mo (${usd((solo.monthly - familyLineMonthly) * 12)}/yr). ${m.name} keeps the same number either way`
    ] : [
      `${solo.name} at ${usd(solo.monthly)}/mo beats the ${usd(familyLineMonthly)}/mo family line. Move ${m.name} to their own plan and keep the number (port it)`
    ]
  };
}
var PREF_LABELS = {
  battery: "long battery life",
  bigScreen: "a bigger screen",
  smallScreen: "a smaller phone",
  camera: "a great camera",
  gaming: "gaming",
  simple: "something simple",
  cheap: "a lower price"
};
function parsePrefs(text) {
  const t = text.toLowerCase();
  const p = {};
  const healthReport = /\b\d{2,3}\s*%|battery health|max(imum)? capacity/.test(t);
  if (/\b(battery|lasts? (all|the whole) day|dies|charging|charge)\b/.test(t) && !healthReport) p.battery = true;
  if (/\b(big(ger)?|large(r)?|huge) (screen|display|phone)\b|\bscreen size\b/.test(t)) p.bigScreen = true;
  if (/\b(small(er)?|compact|one[- ]handed|mini|fits? in (my )?pocket) ?(screen|phone)?\b/.test(t)) p.smallScreen = true;
  if (/\b(camera|photos?|pictures?|selfies?|video|zoom)\b/.test(t)) p.camera = true;
  if (/\b(gaming|games?|fortnite|genshin|fps)\b/.test(t)) p.gaming = true;
  if (/\b(simple|easy to use|big buttons|flip phone|for (my )?(grandma|grandpa|mom|dad))\b/.test(t)) p.simple = true;
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
var hasPrefs = (p) => Object.keys(p).length > 0;
function recommend(world2, memberId, opts = {}) {
  const m = member(world2, memberId);
  const prefs = opts.prefs ?? {};
  const budget = opts.budget ?? prefs.budget;
  const wantsSimple = prefs.simple || m.age >= 70;
  const needCamera = prefs.camera ? 5 : m.usage.camera;
  const needGaming = prefs.gaming ? 5 : m.usage.gaming;
  const phones = world2.catalog.phones;
  const maxBattery = Math.max(...phones.filter((p) => !p.simple).map((p) => p.batteryHours));
  const maxScreen = Math.max(...phones.map((p) => p.screenIn));
  const minScreen = Math.min(...phones.filter((p) => !p.simple).map((p) => p.screenIn));
  return phones.filter((p) => !p.simple || wantsSimple).map((p) => {
    const gb = neededStorage(p, m);
    const price = p.prices[String(gb)];
    const why = [];
    let score = 100;
    score -= 15 * Math.max(0, needCamera - p.camera);
    score -= 15 * Math.max(0, needGaming - p.gaming);
    score -= 5 * Math.max(0, p.camera - needCamera - 1);
    score -= price / (prefs.cheap ? 25 : 50);
    if (p.simple) score += wantsSimple ? 40 : -100;
    if (budget && price > budget) score -= 50;
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
  }).sort((a, b) => b.score - a.score).filter((r, _i, all) => !budget || r.price <= budget || all.filter((x) => x.price <= budget).length < 2).slice(0, 3).map(({ score: _score, ...r }) => r);
}
function mergePrefs(old = {}, next) {
  const merged = { ...old, ...next };
  if (next.bigScreen) delete merged.smallScreen;
  if (next.smallScreen) delete merged.bigScreen;
  return merged;
}
function promosFor(world2, id, day, category) {
  return world2.offers.promos.filter((p) => promoCovers(p, id, category) && p.endsOnDay > day);
}
function linkWords(url) {
  let decoded = url;
  try {
    const u = new URL(url);
    decoded = `${u.pathname} ${u.search}`;
  } catch {
  }
  decoded = decodeURIComponent(decoded);
  return { decoded, words: decoded.replace(/[-_/+=&?.,:]+/g, " ").replace(/([a-z])(\d)/gi, "$1 $2").replace(/(\d)([a-z])/gi, "$1 $2") };
}
function parseLink(world2, url) {
  const { decoded, words } = linkWords(url);
  const ph = bestMatch(world2.catalog.phones, words);
  const pr = bestMatch(world2.catalog.products ?? [], words);
  if (ph && (!pr || ph.score >= pr.score)) {
    const hit = parseProductLink(world2, url);
    return { kind: "phone", ...hit };
  }
  if (!pr) return void 0;
  return { kind: "product", product: pr.item, variant: pickVariant(pr.item, decoded) };
}
function parseProductLink(world2, url) {
  let decoded = url;
  try {
    const u = new URL(url);
    decoded = `${u.pathname} ${u.search}`;
  } catch {
  }
  decoded = decodeURIComponent(decoded);
  const words = decoded.replace(/[-_/+=&?.,:]+/g, " ").replace(/([a-z])(\d)/gi, "$1 $2").replace(/(\d)([a-z])/gi, "$1 $2");
  const p = findPhone(world2, words);
  if (!p) return void 0;
  const opts = Object.keys(p.prices).map(Number);
  const nums = [...decoded.matchAll(/(\d{2,4})\s*(?:gb)?/gi)].map((x) => Number(x[1]));
  const gb = nums.find((n) => opts.includes(n)) ?? Math.min(...opts);
  return { phone: p, storageGB: gb };
}
function describePrefs(p) {
  const parts = Object.keys(PREF_LABELS).filter((k) => p[k] && !(k === "cheap" && p.budget)).map((k) => PREF_LABELS[k]);
  if (p.brand) parts.push(p.brand === "Apple" ? "an iPhone" : `a ${p.brand} phone`);
  if (p.budget) parts.push(`under ${usd(p.budget)}`);
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
function familyBudget(text) {
  const t = text.toLowerCase().replace(/,(\d{3})/g, "$1");
  if (!/\b(our|family|household|total|we have|we can spend|we've got)\b/.test(t)) return void 0;
  const m = t.match(/(?:budget|spend|have|got)[^$\d]{0,20}\$?\s*(\d{3,5})/) ?? t.match(/\$\s*(\d{3,5})/);
  return m ? Number(m[1]) : void 0;
}
var ACCESSORY_TYPE_WORDS = [
  ["case", /\bcases?\b/i],
  ["screen", /\b(screen protector|protector|glass)\b/i],
  ["charger", /\b(charger|charging|magsafe)\b/i],
  ["battery", /\b(power ?bank|battery pack|portable charger)\b/i],
  ["earbuds", /\b(earbuds|airpods|buds|headphones|earphones)\b/i]
];
function accessoryType(text) {
  return ACCESSORY_TYPE_WORDS.find(([, re]) => re.test(text))?.[0];
}
var MAKER_STORES = {
  Apple: { store: "Apple", search: (q) => `https://www.apple.com/us/search/${encodeURIComponent(q.toLowerCase().replace(/\s+/g, "-"))}?src=globalnav` },
  Samsung: { store: "Samsung", search: (q) => `https://www.samsung.com/us/search/searchMain/?listType=g&searchTerm=${encodeURIComponent(q)}` },
  Google: { store: "Google Store", search: (q) => `https://store.google.com/us/search?q=${encodeURIComponent(q)}` }
};
var STORE_SEARCH = {
  "T-Mobile": (q) => `https://www.t-mobile.com/search?q=${encodeURIComponent(q)}`,
  "Best Buy": (q) => `https://www.bestbuy.com/site/searchpage.jsp?st=${encodeURIComponent(q)}`,
  Amazon: (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`
};
var RETAILERS = ["T-Mobile", "Best Buy", "Amazon"];
function shopLinks(name, brands = [], opts = {}) {
  const known = opts.buy ?? [];
  const search = opts.search ?? (known.length ? [] : RETAILERS);
  const maker = brands.length === 1 ? MAKER_STORES[brands[0]] : void 0;
  const out = [];
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
function storeName(url) {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^(www|m|smile)\./, "");
  } catch {
    return "that store";
  }
  const KNOWN = [
    [/(^|\.)amazon\.|(^|\.)amzn\.(to|com)$|^a\.co$/, "Amazon"],
    [/bestbuy\./, "Best Buy"],
    [/walmart\./, "Walmart"],
    [/target\.com$/, "Target"],
    [/costco\./, "Costco"],
    [/t-mobile\.com$/, "T-Mobile"],
    [/apple\.com$/, "Apple"],
    [/store\.google\.com$/, "Google Store"],
    [/samsung\.com$/, "Samsung"],
    [/ebay\./, "eBay"],
    [/homedepot\./, "Home Depot"],
    [/lowes\./, "Lowe's"],
    [/wayfair\./, "Wayfair"],
    [/ikea\./, "IKEA"],
    [/etsy\./, "Etsy"]
  ];
  return KNOWN.find(([re]) => re.test(host))?.[1] ?? host;
}
function nameFromLink(url) {
  let path = "";
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return void 0;
  }
  const words = (seg) => seg.replace(/\.(html?|aspx?|php|p)$/i, "").split(/[-_+\s]+/).filter((w) => /[a-z]/i.test(w) && !/^\d+$/.test(w));
  const best = path.split("/").filter((seg) => !/^(dp|gp|p|ip|product|products|site|shop|buy|item|en-us|us|s)$/i.test(seg) && !/^[A-Z0-9]{8,}$/.test(seg)).map(words).filter((w) => w.length >= 2).sort((x, y) => y.length - x.length)[0];
  if (!best) return void 0;
  return best.slice(0, 6).map((w) => /^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w).join(" ");
}
function cartLinks(world2, i) {
  if (i.kind === "device") {
    const p = world2.catalog.phones.find((x) => x.id === i.phoneId);
    return p && shopLinks(p.name, [p.brand], { buy: p.buy });
  }
  if (i.kind === "accessory") {
    const a = (world2.catalog.accessories ?? []).find((x) => x.id === i.accessoryId);
    return a && accessoryLinks(a);
  }
  if (i.kind === "product") {
    const p = i.productId ? (world2.catalog.products ?? []).find((x) => x.id === i.productId) : void 0;
    if (p) return shopLinks(p.name, [p.brand], { buy: p.buy });
    if (!i.custom) return void 0;
    const pasted = i.url ? [{ store: storeName(i.url), url: i.url, price: i.custom.price }] : [];
    const others = shopLinks(i.custom.name, [], { search: ["Best Buy", "Amazon"] }).filter((l) => l.store !== pasted[0]?.store);
    return [...pasted, ...others];
  }
  return void 0;
}
var accessoryLinks = (a) => shopLinks(a.name, a.brands, { buy: a.buy ?? (a.url ? [{ store: storeName(a.url), url: a.url }] : void 0) });
function shopUrl(a) {
  return accessoryLinks(a)[0].url;
}
function findAccessory(world2, query) {
  const q = query.toLowerCase().replace(/[^a-z0-9 ]+/g, " ");
  const words = q.split(/\s+/).filter((w) => w.length > 2);
  const scored = (world2.catalog.accessories ?? []).map((a) => {
    const name = a.name.toLowerCase().replace(/[^a-z0-9 ]+/g, " ");
    return { a, score: words.filter((w) => name.includes(w)).length };
  });
  const best = scored.sort((x, y) => y.score - x.score)[0];
  return best && best.score > 0 ? best.a : void 0;
}
function phoneBrandFor(world2, memberId, cart = []) {
  const inCart = cart.find((i) => i.kind === "device" && i.memberId === memberId && i.phoneId);
  if (inCart) return phone(world2, inCart.phoneId).brand;
  const model = member(world2, memberId).device.model.toLowerCase();
  return /iphone/.test(model) ? "Apple" : /pixel/.test(model) ? "Google" : /galaxy|samsung/.test(model) ? "Samsung" : "any";
}
var fits = (a, brand) => a.brands.includes("any") || brand === "any" || a.brands.includes(brand);
function recommendAccessories(world2, memberId, opts = {}) {
  const m = member(world2, memberId);
  const brand = phoneBrandFor(world2, memberId, opts.cart);
  const young = m.age < 20 || ["teen", "kid"].includes(m.role);
  const pool = (world2.catalog.accessories ?? []).filter((a) => fits(a, brand) && (!opts.type || a.type === opts.type));
  const rank = (a) => (a.brands.includes(brand) ? 0 : 1) * 1e3 + // made for their phone first
  (a.id === "rugged-case" && young ? -2e3 : 0) + // teens: the drop-proof case
  a.price;
  const sorted = pool.sort((x, y) => rank(x) - rank(y));
  const picks = opts.type ? sorted.slice(0, 3) : ["case", "screen", "charger"].map((t) => sorted.find((a) => a.type === t)).filter(Boolean);
  return picks.map((a) => ({
    accessoryId: a.id,
    name: a.name,
    type: a.type,
    price: a.price,
    shopUrl: shopUrl(a),
    shopLinks: accessoryLinks(a),
    why: [a.note ?? (a.brands.includes(brand) ? `made for ${{ Apple: "iPhone", Google: "Pixel phones", Samsung: "Galaxy phones" }[brand] ?? "your phone"}` : "works with any phone")]
  }));
}
function reviewAccessory(world2, item, cart) {
  const m = member(world2, item.memberId);
  const a = (world2.catalog.accessories ?? []).find((x) => x.id === item.accessoryId);
  if (!a) throw new Error(`Unknown accessory "${item.accessoryId}"`);
  const brand = phoneBrandFor(world2, m.id, cart);
  const label = `${m.name} \xB7 ${a.name}`;
  if ((a.type === "case" || a.type === "charger") && !fits(a, brand)) {
    return { itemId: item.id, memberId: m.id, label, stamp: "CUT", reasons: [`Doesn't fit ${m.name.split(/\s+/)[0]}'s ${brand} phone`], originalCost: a.price, nowCost: 0, heldCost: 0, savings: a.price };
  }
  const sameType = cart.filter((i) => i.kind === "accessory" && i.memberId === m.id && (world2.catalog.accessories ?? []).find((x) => x.id === i.accessoryId)?.type === a.type);
  if (sameType.length > 1 && sameType[0].id !== item.id) {
    return { itemId: item.id, memberId: m.id, label, stamp: "CUT", reasons: [`Already getting a ${a.type === "screen" ? "screen protector" : a.type}`], originalCost: a.price, nowCost: 0, heldCost: 0, savings: a.price };
  }
  return { itemId: item.id, memberId: m.id, label, stamp: "KEEP", reasons: [a.note ? `Worth it: ${a.note}` : `Fits ${m.name.split(/\s+/)[0]}'s ${brand === "Apple" ? "iPhone" : brand + " phone"}`], originalCost: a.price, nowCost: a.price, heldCost: 0, savings: 0 };
}
var COOLING_OFF_DAYS = 30;
var categories = (world2) => world2.catalog.categories ?? {};
function product(world2, id) {
  const p = world2.catalog.products?.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown product "${id}"`);
  return p;
}
function findCategory(world2, text) {
  const t = ` ${norm(text)} `;
  const hits = Object.entries(categories(world2)).flatMap(([id, c]) => c.words.map((w) => ({ id, w: norm(w) }))).filter(({ w }) => t.includes(` ${w} `)).sort((a, b) => b.w.length - a.w.length);
  return hits[0]?.id;
}
var variants = (p) => Object.keys(p.prices).sort((a, b) => p.prices[a] - p.prices[b]);
function pickVariant(p, text = "") {
  const t = norm(text).replace(/(\d) (in|inch|gb|tb)\b/g, "$1$2").replace(/inch\b/g, "in");
  return variants(p).find((v) => v !== "std" && new RegExp(`\\b${norm(v).replace(/ /g, "")}\\b`).test(t)) ?? variants(p)[0];
}
var productLabel = (p, variant) => variant === "std" ? p.name : `${p.name} ${variant}`;
function ownedFor(world2, memberId, category) {
  const owned = world2.household.owned ?? [];
  return owned.find((o) => o.memberId === memberId && o.category === category) ?? owned.find((o) => !o.memberId && o.category === category);
}
function productProtection(m, price) {
  const monthly = Math.max(3, Math.round(price * 0.01));
  const young = m.age < 20 || ["teen", "kid"].includes(m.role);
  if (price >= 800 && young) return { verdict: "ADD", monthly, reason: `Teens drop things: ${usd(monthly)}/mo protects a ${usd(price)} purchase` };
  if (price < 250) return { verdict: "SKIP", monthly, reason: `Skip it: ${usd(monthly * 12)}/yr is a lot next to a ${usd(price)} purchase` };
  return { verdict: "OPTIONAL", monthly, reason: `Optional: ${usd(monthly * 12)}/yr. Check the card you pay with first, many add a free extra year of warranty` };
}
var years = (months) => months % 12 === 0 ? `${months / 12} years` : `${months} months`;
function reviewProduct(world2, item, day, opts, cart) {
  const m = member(world2, item.memberId);
  const qty = Math.max(1, Math.round(item.quantity ?? 1));
  const picked = item.productId ? product(world2, item.productId) : void 0;
  if (!picked && !item.custom) throw new Error(`Cart item ${item.id} has no product`);
  const category = picked?.category ?? item.custom?.category;
  const cat = category ? categories(world2)[category] : void 0;
  const pickedVariant = picked ? item.variant && item.variant in picked.prices ? item.variant : variants(picked)[0] : "std";
  const many = (name2) => qty > 1 ? `${qty} \xD7 ${name2}` : name2;
  const pickedName = picked ? productLabel(picked, pickedVariant) : item.custom.name;
  const pickedUnit = picked ? picked.prices[pickedVariant] : item.custom.price;
  const originalCost = pickedUnit * qty;
  const label = `${m.name} \xB7 ${many(pickedName)}`;
  const math = [{ label: `${many(pickedName)}, as argued`, amount: originalCost }];
  const sameAs = (c) => c.kind === "product" && c.memberId === m.id && (picked ? c.productId === picked.id : c.custom?.name.toLowerCase() === item.custom.name.toLowerCase());
  const first4 = cart.find(sameAs);
  if (first4 && first4.id !== item.id) {
    return {
      itemId: item.id,
      memberId: m.id,
      label,
      stamp: "CUT",
      reasons: [`Already in the cart for ${m.name}. One is enough`],
      originalCost,
      nowCost: 0,
      heldCost: 0,
      savings: originalCost,
      math: [...math, { label: "Struck: duplicate", amount: -originalCost }]
    };
  }
  const reasons2 = [];
  let target = picked;
  let variant = pickedVariant;
  if (picked && opts.tightBudget && picked.tier === "flagship") {
    const cheaper = (world2.catalog.products ?? []).filter((p) => p.category === picked.category && p.tier !== "flagship" && p.rating >= picked.rating - 1).sort((a, b) => Number(b.brand === picked.brand) - Number(a.brand === picked.brand) || b.rating - a.rating || Math.min(...Object.values(a.prices)) - Math.min(...Object.values(b.prices)))[0];
    if (cheaper) {
      target = cheaper;
      variant = pickedVariant in cheaper.prices ? pickedVariant : variants(cheaper)[0];
      reasons2.push(`Keeping this month's total in check: the ${cheaper.name} is rated ${cheaper.rating}/5 for less`);
    }
  }
  const unit = target ? target.prices[variant] : pickedUnit;
  const name = target ? productLabel(target, variant) : pickedName;
  let price = unit * qty;
  if (price !== originalCost) math.push({ label: `Switch to ${many(name)}`, amount: price - originalCost });
  const owned = category ? ownedFor(world2, m.id, category) : void 0;
  if (owned?.tradeInValue && !owned.broken) {
    reasons2.push(`Trade in the ${owned.name}: \u2212${usd(owned.tradeInValue)}`);
    price -= owned.tradeInValue;
    math.push({ label: `Trade-in: ${owned.name}`, amount: -owned.tradeInValue });
  }
  const urgent = !!owned?.broken;
  const stillGood = !!owned && !owned.broken && !!cat?.lifespanMonths && owned.ageMonths < cat.lifespanMonths;
  const id = target?.id ?? `custom:${item.id}`;
  const custom = target ? void 0 : { price: unit, category };
  const { active, upcoming } = promoFor(world2, id, day, { category, sticker: unit });
  if (active) {
    const off = promoCredit(active, unit) * qty;
    reasons2.push(`${active.name} is live: ${promoText(active, unit * qty)}`);
    price -= off;
    math.push({ label: `${active.name} (live now)`, amount: -off });
  }
  let holdUntilDay;
  if (!urgent && upcoming && !active) {
    holdUntilDay = upcoming.startsOnDay;
    const off = promoCredit(upcoming, unit) * qty;
    reasons2.push(`${upcoming.name} starts in ${upcoming.startsOnDay - day} days: ${promoText(upcoming, unit * qty)}`);
    price -= off;
    math.push({ label: `${upcoming.name} (from day ${upcoming.startsOnDay})`, amount: -off });
  }
  if (stillGood && holdUntilDay === void 0 && !active) {
    holdUntilDay = day + COOLING_OFF_DAYS;
    reasons2.push(`It's a want, not a need yet: sleep on it for ${COOLING_OFF_DAYS} days. Still want it then? Buy it`);
  }
  if (owned?.broken) reasons2.unshift(`The ${owned.name} is broken. Replacing it now makes sense`);
  else if (stillGood) reasons2.unshift(`The ${owned.name} still works and is ${owned.ageMonths} months old. A ${cat.label} lasts about ${years(cat.lifespanMonths)}`);
  else if (owned && cat?.lifespanMonths) reasons2.unshift(`The ${owned.name} is ${owned.ageMonths} months old, past the ~${years(cat.lifespanMonths)} a ${cat.label} lasts. Fair to replace`);
  if (!reasons2.length) reasons2.push(`Fair price. No sale coming up in the next ${PROMO_LOOKAHEAD_DAYS} days`);
  const changed2 = target !== picked;
  const stamp = holdUntilDay !== void 0 ? "WAIT" : changed2 ? "SWAP" : "KEEP";
  const witness = stamp === "WAIT" && owned && !owned.broken ? `I am the ${owned.name}. I am ${owned.ageMonths} months old and I still do my job every day. I'd like to be heard before I'm replaced.` : void 0;
  return {
    itemId: item.id,
    memberId: m.id,
    label,
    stamp,
    reasons: reasons2,
    originalCost,
    nowCost: stamp === "WAIT" ? 0 : price,
    heldCost: stamp === "WAIT" ? price : 0,
    savings: originalCost - price,
    holdUntilDay,
    proposed: { productId: id, variant, label: many(name) },
    witness,
    witnessOf: witness ? owned.memberId ? `${m.name}'s ${owned.name}` : `the household's ${owned.name}` : void 0,
    urgent,
    math,
    protection: cat?.fragile ? productProtection(m, unit) : void 0,
    track: priceTrack(world2, id, variant, day, Math.max(90, (holdUntilDay ?? day) - day + 40), custom)
  };
}
function recommendProducts(world2, memberId, category, opts = {}) {
  const m = member(world2, memberId);
  const cat = categories(world2)[category];
  if (!cat) throw new Error(`Unknown category "${category}". Categories: ${Object.keys(categories(world2)).join(", ")}`);
  const owned = ownedFor(world2, m.id, category);
  const brand = opts.brand?.toLowerCase();
  return (world2.catalog.products ?? []).filter((p) => p.category === category).map((p) => {
    const variant = variants(p)[0];
    const price = p.prices[variant];
    const why = [];
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
    if (owned?.tradeInValue && !owned.broken) why.push(`trade in the ${owned.name} for \u2212${usd(owned.tradeInValue)}`);
    return { productId: p.id, name: p.name, variant, price, why, score };
  }).sort((a, b) => b.score - a.score).filter((r, _i, all) => !opts.budget || r.price <= opts.budget || all.filter((x) => x.price <= opts.budget).length < 2).slice(0, 3).map(({ score: _score, ...r }) => r);
}
function cartLabel(world2, i) {
  const many = (name) => (i.quantity ?? 1) > 1 ? `${i.quantity} \xD7 ${name}` : name;
  if (i.kind === "device") return `${phone(world2, i.phoneId).name} ${i.storageGB}GB`;
  if (i.kind === "product") return many(i.custom?.name ?? productLabel(product(world2, i.productId), i.variant ?? variants(product(world2, i.productId))[0]));
  return world2.catalog.addons.find((a) => a.id === i.addonId)?.name ?? "an add-on";
}
function cartPrice(world2, i) {
  if (i.kind === "device") return phone(world2, i.phoneId).prices[String(i.storageGB)];
  if (i.kind === "product") {
    const p = i.productId ? product(world2, i.productId) : void 0;
    return (p ? p.prices[i.variant ?? variants(p)[0]] : i.custom.price) * (i.quantity ?? 1);
  }
  return (world2.catalog.addons.find((a) => a.id === i.addonId)?.monthly ?? 0) * 12;
}

// src/store.ts
import { EventEmitter } from "node:events";

// src/data.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/db.ts
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
var KEYS = ["household", "claims", "welcomed", "state", "checkpoints", "accounts"];
var dataDir = process.env.CART_COURT_DATA_DIR ? process.env.CART_COURT_DATA_DIR.replace(/[\/]?$/, "/") : fileURLToPath(new URL("../data/", import.meta.url));
var fileFor = (key) => `${dataDir}${key}.local.json`;
var readFile = (key) => existsSync(fileFor(key)) ? JSON.parse(readFileSync(fileFor(key), "utf8")) : void 0;
var docs;
var cache = /* @__PURE__ */ new Map();
async function connect(uri2) {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri2, { serverSelectionTimeoutMS: 8e3, appName: "cart-court" });
  await client.connect();
  const coll = client.db(process.env.MONGODB_DB || "cartcourt").collection("kv");
  for (const d of await coll.find().toArray()) cache.set(d._id, JSON.parse(d.json));
  for (const key of KEYS) {
    const local = cache.has(key) ? void 0 : readFile(key);
    if (local === void 0) continue;
    cache.set(key, local);
    await coll.replaceOne({ _id: key }, { json: JSON.stringify(local), updatedAt: /* @__PURE__ */ new Date() }, { upsert: true });
    console.log(`[db] copied data/${key}.local.json into MongoDB`);
  }
  docs = coll;
}
var uri = process.env.MONGODB_URI;
var backend = process.env.CART_COURT_DB === "memory" ? "memory" : "files";
if (uri && backend !== "memory") {
  try {
    await connect(uri);
    backend = "mongodb";
  } catch (err) {
    console.error(`[db] couldn't reach MongoDB, saving to local files instead: ${err.message}`);
  }
}
if (backend === "files") for (const key of KEYS) {
  const v = readFile(key);
  if (v !== void 0) cache.set(key, v);
}
if (backend !== "memory") console.log(`[db] ${backend === "mongodb" ? `MongoDB (${process.env.MONGODB_DB || "cartcourt"})` : "local files in data/"}`);
function get(key, fallback) {
  return cache.has(key) ? structuredClone(cache.get(key)) : fallback;
}
var dirty = /* @__PURE__ */ new Set();
var timer;
var writing = Promise.resolve();
function put(key, value) {
  cache.set(key, structuredClone(value));
  if (backend === "memory") return;
  dirty.add(key);
  timer ??= setTimeout(() => void flush(), 250);
}
async function write(key, value) {
  const json = JSON.stringify(value);
  if (docs) {
    await docs.replaceOne({ _id: key }, { json, updatedAt: /* @__PURE__ */ new Date() }, { upsert: true });
  } else {
    writeFileSync(fileFor(key) + ".tmp", json);
    renameSync(fileFor(key) + ".tmp", fileFor(key));
  }
}
function flush() {
  clearTimeout(timer);
  timer = void 0;
  const keys = [...dirty];
  dirty.clear();
  writing = writing.then(async () => {
    for (const key of keys) {
      try {
        await write(key, cache.get(key));
      } catch (err) {
        console.error(`[db] couldn't save ${key}:`, err.message);
        dirty.add(key);
      }
    }
  });
  return writing;
}
var beforeExit = [];
var onShutdown = (fn) => beforeExit.push(fn);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    beforeExit.forEach((fn) => fn());
    await flush();
    process.exit(0);
  });
}
var reloadHooks = [];
var onReload = (fn) => reloadHooks.push(fn);
async function reload() {
  if (!docs) return;
  for (const d of await docs.find().toArray()) {
    if (!dirty.has(d._id)) cache.set(d._id, JSON.parse(d.json));
  }
  for (const fn of reloadHooks) fn();
}

// src/data.ts
var dataDir2 = fileURLToPath2(new URL("../data/", import.meta.url));
var load = (file) => JSON.parse(readFileSync2(dataDir2 + file, "utf8"));
function loadHouseholdLocal() {
  return get("household", { members: {} });
}
function saveHouseholdLocal(local) {
  put("household", local);
}
function loadWorld(opts = {}) {
  const world2 = {
    catalog: load("catalog.json"),
    household: load("household.json"),
    offers: load("offers.json")
  };
  const local = opts.local === false ? { members: {} } : loadHouseholdLocal();
  for (const m of world2.household.members) {
    const o = local.members[m.id];
    if (o?.name) m.name = o.name;
    if (o?.handles?.length) m.handles = o.handles;
    if (o?.role) m.role = o.role;
    if (o?.phoneModel) m.device.model = o.phoneModel;
    if (o?.batteryHealth) m.device.batteryHealth = o.batteryHealth;
  }
  return world2;
}
function savedMemberIds() {
  return Object.keys(loadHouseholdLocal().members);
}

// src/store.ts
var world = loadWorld();
var bus = new EventEmitter();
var fresh = () => ({ day: 0, cart: [], privateNotes: {}, chat: [], exhibits: [], activity: [], prefs: {}, lastRecs: {}, seenIds: [], purchases: [], trialRuns: 0 });
function fromSaved(saved) {
  if (!saved) return fresh();
  const { evidence = {}, owned, ...rest } = structuredClone(saved);
  for (const m of world.household.members) Object.assign(m.device, evidence[m.id] ?? {});
  if (owned) world.household.owned = owned;
  return { ...fresh(), ...rest };
}
var state = fromSaved(get("state", void 0));
function snapshot() {
  const { pendingImage: _p, ...rest } = state;
  const saved = structuredClone({
    ...rest,
    chat: rest.chat.map(({ image: _i, ...line }) => line),
    // simulator photos are big and only matter live
    evidence: Object.fromEntries(world.household.members.map((m) => [m.id, { batteryHealth: m.device.batteryHealth, screenCracked: m.device.screenCracked }])),
    owned: world.household.owned
  });
  if (JSON.stringify(saved).length > 12e6) {
    saved.exhibits = saved.exhibits.map(({ image: _i, ...e }) => e);
  }
  return saved;
}
function restoreSnapshot(snap) {
  Object.assign(world, loadWorld());
  state = fromSaved(snap);
  changed();
}
onReload(() => {
  Object.assign(world, loadWorld());
  state = fromSaved(get("state", void 0));
  lastSaved = "";
});
var lastSaved = "";
function persist() {
  const saved = snapshot();
  const json = JSON.stringify(saved);
  if (json === lastSaved) return;
  lastSaved = json;
  put("state", saved);
}
setInterval(persist, 2e3).unref();
onShutdown(persist);
var seq = 0;
var newId = (prefix) => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;
function changed() {
  persist();
  bus.emit("state", publicState());
}
function publicState() {
  return {
    day: state.day,
    household: world.household.name,
    courtNumber: process.env.COURT_NUMBER ?? "",
    // shown on the case file so judges can text in
    members: world.household.members.map((m) => ({ id: m.id, name: m.name, role: m.role, device: m.device.model })),
    cart: state.cart.map((i) => {
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
    appeals: Object.values(Object.fromEntries((state.appeals ?? []).map((a) => [a.itemId, a])))
  };
}
function checkedOn(i) {
  const c = world.catalog;
  return (c.phones.find((x) => x.id === i.phoneId) ?? (c.accessories ?? []).find((x) => x.id === i.accessoryId) ?? (c.products ?? []).find((x) => x.id === i.productId))?.checked;
}
function addChat(line) {
  const full = { ...line, id: newId("m"), at: Date.now() };
  state.chat.push(full);
  if (state.chat.length > 500) state.chat.shift();
  bus.emit("chat", full);
  persist();
  return full;
}
var BUDGET_WORDS = /\b(tight|budget|afford|broke|expensive|money|bills?)\b/i;
var spent = () => state.purchases.reduce((t, p) => t + p.paid, 0);
var remainingBudget = () => state.budget === void 0 ? void 0 : Math.max(0, state.budget - spent());
function trialOpts() {
  return { tightBudget: Object.values(state.privateNotes).flat().some((n) => BUDGET_WORDS.test(n)), prefs: state.prefs, budget: remainingBudget() };
}
function logActivity(lines) {
  for (const text of lines) state.activity.push({ at: Date.now(), day: state.day, text });
  if (state.activity.length > 200) state.activity.splice(0, state.activity.length - 200);
  if (lines.length) changed();
}
function refreshTrial() {
  if (state.trial) state.trial = runTrial(world, state.cart, state.day, trialOpts());
}
function reset() {
  Object.assign(world, loadWorld());
  state = fresh();
  changed();
}

// src/share.ts
import { readFileSync as readFileSync5 } from "node:fs";
import { fileURLToPath as fileURLToPath4 } from "node:url";
import { Router as Router3 } from "express";
import QRCode from "qrcode";

// src/channels/photon.ts
import { Spectrum } from "spectrum-ts";
import { effect as withEffect, imessage } from "spectrum-ts/providers/imessage";

// src/claims.ts
var claims = get("claims", {});
onReload(() => {
  for (const k of Object.keys(claims)) delete claims[k];
  Object.assign(claims, get("claims", {}));
});
var SIM_HANDLE = "+15555550199";
var asked = /* @__PURE__ */ new Set();
var digits = (s) => s.replace(/\D/g, "").slice(-10);
var same = (a, b) => a.toLowerCase() === b.toLowerCase() || digits(a).length >= 7 && digits(a) === digits(b);
function memberForHandle(handle2) {
  if (!handle2) return void 0;
  const fromFile = world.household.members.find((m) => m.handles.some((h) => same(h, handle2)));
  if (fromFile) return fromFile.id;
  const key = Object.keys(claims).find((k) => same(k, handle2));
  return key ? claims[key] : void 0;
}
function claim(handle2, memberId) {
  claims[handle2] = memberId;
  put("claims", Object.fromEntries(Object.entries(claims).filter(([h]) => h !== SIM_HANDLE)));
}
function forgetClaims() {
  delete claims[SIM_HANDLE];
  asked.clear();
}
function introducedAs(text) {
  const t = text.toLowerCase();
  const word = (w) => new RegExp(`\\b${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t);
  const byName = world.household.members.find((m) => word(m.name) || word(m.name.split(/\s+/)[0]));
  if (byName) return byName.id;
  const roles = [
    [/\b(dad|father)\b/, (m) => m.id === "marco"],
    [/\b(mom|mum|mother)\b/, (m) => m.id === "elena"],
    [/\b(grandma|grandmother|abuela)\b/, (m) => m.role === "grandparent"]
  ];
  for (const [re, pick] of roles) if (re.test(t)) return world.household.members.find(pick)?.id;
  return void 0;
}
function shouldAsk(handle2, isGroup) {
  if (!isGroup) return true;
  if (asked.has(handle2)) return false;
  asked.add(handle2);
  return true;
}
function welcomeQuestion() {
  const saved = savedMemberIds();
  const names = world.household.members.filter((m) => !saved.length || saved.includes(m.id)).map((m) => m.name);
  if (names.length === 1) return `\u2696\uFE0F Welcome to Cart Court! Is this ${names[0]}? Reply with your name.`;
  return `\u2696\uFE0F Welcome to Cart Court, the honest phone-shopping assistant for ${world.household.name}. Who's texting? Reply with your name: ${names.slice(0, -1).join(", ")} or ${names.at(-1)}.`;
}
function welcome(memberId) {
  const m = world.household.members.find((x) => x.id === memberId);
  const first4 = m.name.split(/\s+/)[0];
  const d = m.device;
  const smartphone = d.storageGB >= 16;
  const mine = state.cart.filter((i) => i.memberId === m.id && i.kind === "device" && i.phoneId).map((i) => `${world.catalog.phones.find((p) => p.id === i.phoneId)?.name ?? "a phone"} ${i.storageGB}GB`);
  const inCart = mine.length ? `
\u{1F4E5} Already in the family cart for you: ${mine.join(", ")}.` : "";
  if (m.role === "grandparent") {
    return `Welcome to the court, ${first4}! \u2696\uFE0F I help the family pick phones without overspending.${inCart}
Just text me in your own words, like "I want a phone that's easy to read" or "what phone should I get?"`;
  }
  const facts = [
    smartphone && `${d.batteryHealth}% battery health`,
    d.installmentsLeft > 0 && `${d.installmentsLeft} payment${d.installmentsLeft === 1 ? "" : "s"} of ${usd(d.monthlyInstallment)} left`,
    tradeIn(m).value > 0 && `worth ${usd(tradeIn(m).value)} in trade${d.screenCracked ? " (cracked screen)" : ""}`
  ].filter(Boolean);
  const manager = m.role === "parent" || m.role === "partner";
  return [
    `Welcome to the court, ${first4}! \u2696\uFE0F`,
    `On file: your ${d.model}${facts.length ? ` (${facts.join(" \xB7 ")})` : ""}. Changed? Text me, like "battery health 79%".${inCart}`,
    "Try:",
    `\u2022 "what phone should I get?" (say what matters: camera, battery, budget)`,
    "\u2022 Paste a store link to add it to the family cart",
    manager ? `\u2022 "our phone budget is $2,000", then "court, rule" when everyone's in` : `\u2022 "court, rule" when everyone's in. The court decides what to buy now and what should wait.`
  ].join("\n");
}
function claimedHandles(memberId) {
  return Object.entries(claims).filter(([h, id]) => id === memberId && h !== SIM_HANDLE).map(([h]) => h);
}

// src/runtime.ts
var serverless = !!process.env.VERCEL;
var pending = /* @__PURE__ */ new Set();
function background(work) {
  const p = work.catch((err) => console.error("[background]", err));
  pending.add(p);
  p.finally(() => pending.delete(p));
}
function later(fn, ms) {
  if (serverless) background(Promise.resolve().then(fn));
  else setTimeout(() => void Promise.resolve().then(fn).catch((err) => console.error("[later]", err)), ms);
}
async function settle() {
  await new Promise((r) => setTimeout(r, 50));
  while (pending.size) await Promise.allSettled([...pending]);
}
var waitUntilFn;
async function keepAlive(p) {
  if (!serverless) return;
  if (!waitUntilFn) {
    try {
      ({ waitUntil: waitUntilFn } = await import("@vercel/functions"));
    } catch {
      waitUntilFn = () => {
      };
    }
  }
  waitUntilFn(p);
}

// src/effects.ts
function effectFor(text) {
  if (process.env.CART_COURT_EFFECTS === "off") return void 0;
  if (text.startsWith("\u2696\uFE0F THE COURT RULES")) return "slam";
  if (text.startsWith("\u23F3\u27A1\uFE0F\u2705")) return "confetti";
  return void 0;
}

// src/channels/index.ts
var senders = /* @__PURE__ */ new Map();
function registerChannel(prefix, send) {
  senders.set(prefix, send);
}
async function sendTo(spaceId, text, isPrivate = false) {
  const effect = effectFor(text);
  addChat({ spaceId, from: "court", text, private: isPrivate, ...effect && { effect } });
  const send = senders.get(spaceId.split(":")[0]);
  if (send) await send(spaceId, text, effect);
}

// src/tapback.ts
var VERB = { "\u{1F44E}": "Disliked", "\u2753": "Questioned", "\u{1F44D}": "Liked", "\u2764\uFE0F": "Loved", "\u{1F602}": "Laughed at", "\u203C\uFE0F": "Emphasized" };
var RULING = /THE COURT RULES|asked the court to rule|APPEAL (DENIED|GRANTED|PARTLY GRANTED)|ruling is|\bWAIT\b|\bBUY\b|Overruled|Reinstated/;
function tapbackText(emoji, targetText, fromCourt) {
  if (!fromCourt || !targetText || !RULING.test(targetText)) return void 0;
  const about = targetText.match(/APPEAL (?:DENIED|GRANTED|PARTLY GRANTED), (\w+)|Why (\w+)'s ruling/);
  const name = about?.[1] ?? about?.[2];
  if (emoji === "\u{1F44E}") return name ? `I appeal for ${name}` : "I appeal";
  if (emoji === "\u2753") return name ? `why ${name}?` : "why?";
  return void 0;
}
function tapbackLog(emoji, targetText = "") {
  const quote = targetText.split("\n")[0].slice(0, 40);
  return `${VERB[emoji] ?? `Reacted ${emoji} to`} \u201C${quote}${targetText.split("\n")[0].length > 40 ? "\u2026" : ""}\u201D`;
}
var TAPBACKS = Object.keys(VERB);

// src/channels/photon.ts
var spaces = /* @__PURE__ */ new Map();
var handleSpace = /* @__PURE__ */ new Map();
var app;
var connecting;
var generation = 0;
var photonStatus = { state: "off" };
function lineOf(space) {
  try {
    const phone2 = imessage(space)?.phone;
    return phone2 && /\d{7,}/.test(phone2.replace(/\D/g, "")) ? phone2 : void 0;
  } catch {
    return void 0;
  }
}
async function connect2() {
  const { PHOTON_PROJECT_ID: projectId, PHOTON_PROJECT_SECRET: projectSecret } = process.env;
  if (!projectId || !projectSecret) {
    photonStatus.state = "off";
    return void 0;
  }
  photonStatus.state = "connecting";
  photonStatus.error = void 0;
  try {
    app = await Spectrum({ projectId, projectSecret, providers: [imessage.config()] });
  } catch (err) {
    photonStatus.state = "error";
    photonStatus.error = String(err.message ?? err);
    console.error("[photon] failed to start:", photonStatus.error);
    return void 0;
  }
  registerChannel("photon", async (spaceId, text, effect) => {
    const space = spaces.get(spaceId.slice("photon:".length));
    if (!space) return;
    if (effect) {
      try {
        await space.send(withEffect(text, imessage.effect.message[effect]));
        return;
      } catch (e) {
        console.warn(`[photon] ${effect} effect failed, sending plain:`, e.message);
      }
    }
    await space.send(text);
  });
  photonStatus.state = "connected";
  reconnectDelay = 2e3;
  return app;
}
async function ensureApp() {
  if (app && photonStatus.state === "connected") return app;
  connecting ??= connect2().finally(() => connecting = void 0);
  const a = await connecting;
  if (!a) {
    throw new Error(photonStatus.state === "error" ? `Photon couldn't connect: ${photonStatus.error}` : "Photon isn't connected. Paste the Project ID and Secret in step 2 on /setup.");
  }
  return a;
}
function alreadySeen(id) {
  if (state.seenIds.includes(id)) return true;
  state.seenIds.push(id);
  if (state.seenIds.length > 300) state.seenIds.splice(0, state.seenIds.length - 300);
  return false;
}
async function onInbound(space, message) {
  if (message.direction === "outbound" || alreadySeen(message.id)) return;
  spaces.set(space.id, space);
  photonStatus.line ??= lineOf(space);
  const content = message.content;
  if (content.type === "reaction") return onTapback(space, message, content.emoji ?? "", content.target);
  let text = content.type === "text" ? content.text ?? "" : "";
  let image;
  if (content.type === "attachment" && content.mimeType?.startsWith("image/") && content.read) {
    image = { mimeType: content.mimeType, base64: (await content.read()).toString("base64") };
    text ||= "[photo]";
  }
  if (!text && !image) return;
  const isGroup = space.type === "group";
  const spaceId = `photon:${space.id}`;
  const handle2 = message.sender?.id;
  if (handle2 && !isGroup) handleSpace.set(handle2, space.id);
  const memberId = memberForHandle(handle2);
  addChat({ spaceId, from: memberId ?? handle2 ?? "unknown", text, private: !isGroup, image: image ? `data:${image.mimeType};base64,${image.base64}` : void 0 });
  console.log(`[photon] ${handle2} (${memberId ?? "new"}): ${text.slice(0, 80)}`);
  try {
    const reply = await space.responding(() => handle({ spaceId, isGroup, memberId, handle: handle2, text, image }));
    if (reply) await sendTo(spaceId, reply, !isGroup);
  } catch (err) {
    console.error("[photon] handler failed", err);
  }
}
function textOf(m) {
  const c = m?.content;
  return c?.type === "text" ? c.text : c?.type === "effect" && c.content?.type === "text" ? c.content.text : void 0;
}
async function onTapback(space, message, emoji, target) {
  const isGroup = space.type === "group";
  const spaceId = `photon:${space.id}`;
  const handle2 = message.sender?.id;
  const memberId = memberForHandle(handle2);
  if (!memberId) return;
  if (target?.id && alreadySeen(`tap:${target.id}:${handle2}:${emoji}`)) return;
  const targetText = textOf(target);
  addChat({ spaceId, from: memberId, text: tapbackLog(emoji, targetText), private: !isGroup });
  const text = tapbackText(emoji, targetText, target?.direction !== "inbound");
  if (!text) return;
  console.log(`[photon] ${handle2} (${memberId}) tapped ${emoji}: "${text}"`);
  try {
    const reply = await space.responding(() => handle({ spaceId, isGroup, memberId, handle: handle2, text, addressed: true }));
    if (reply) await sendTo(spaceId, reply, !isGroup);
  } catch (err) {
    console.error("[photon] tapback handler failed", err);
  }
}
async function startPhoton() {
  const myGen = ++generation;
  if (app) {
    await app.stop().catch(() => {
    });
    app = void 0;
  }
  if (!process.env.PHOTON_PROJECT_ID || !process.env.PHOTON_PROJECT_SECRET) {
    photonStatus.state = "off";
    console.log("[photon] PHOTON_PROJECT_ID/SECRET not set: real phone channel disabled (simulator still works)");
    return;
  }
  const a = await connect2();
  if (!a) return scheduleReconnect(myGen);
  if (serverless) return;
  console.log("[photon] connected, listening for messages");
  try {
    for await (const [space, message] of a.messages) {
      if (myGen !== generation) break;
      await onInbound(space, message);
    }
    if (myGen === generation) throw new Error("message stream ended");
  } catch (err) {
    if (myGen !== generation) return;
    photonStatus.state = "error";
    photonStatus.error = `Lost the iMessage connection (${err.message}). Reconnecting\u2026`;
    console.error("[photon]", photonStatus.error);
    scheduleReconnect(myGen);
  }
}
var reconnectDelay = 2e3;
var reconnectTimer;
function scheduleReconnect(fromGen) {
  if (serverless || fromGen !== generation || reconnectTimer) return;
  if (!process.env.PHOTON_PROJECT_ID || !process.env.PHOTON_PROJECT_SECRET) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 6e4);
  console.log(`[photon] reconnecting in ${Math.round(delay / 1e3)}s`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = void 0;
    if (fromGen === generation) startPhoton().catch((err) => console.error("[photon] reconnect failed:", err));
  }, delay);
}
async function handleWebhook(body, headers) {
  const a = await ensureApp();
  return a.webhook({ body, headers }, (space, message) => {
    const work = onInbound(space, message);
    background(work);
    return work;
  });
}
async function sayHello(handle2) {
  const a = await ensureApp();
  const im = imessage(a);
  const space = await im.space.create(await im.user(handle2));
  spaces.set(space.id, space);
  handleSpace.set(handle2, space.id);
  const memberId = memberForHandle(handle2);
  const text = memberId ? welcome(memberId) : welcomeQuestion();
  await sendTo(`photon:${space.id}`, text, true);
  const line = lineOf(space);
  if (line) photonStatus.line = line;
  return { line };
}
var photonReady = () => !!process.env.PHOTON_PROJECT_ID && !!process.env.PHOTON_PROJECT_SECRET && photonStatus.state !== "error" && (serverless || photonStatus.state === "connected");
var hasSpace = (spaceId) => spaces.has(spaceId.replace(/^photon:/, ""));
async function sendToHandle(handle2, text) {
  const a = await ensureApp();
  let id = handleSpace.get(handle2);
  if (!id || !spaces.has(id)) {
    const im = imessage(a);
    const space = await im.space.create(await im.user(handle2));
    spaces.set(space.id, space);
    handleSpace.set(handle2, space.id);
    id = space.id;
  }
  await sendTo(`photon:${id}`, text, true);
  return id;
}

// src/setup.ts
import { createHash, timingSafeEqual as timingSafeEqual2 } from "node:crypto";
import { existsSync as existsSync3, readFileSync as readFileSync4, utimesSync, writeFileSync as writeFileSync2 } from "node:fs";
import { fileURLToPath as fileURLToPath3 } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { Router as Router2 } from "express";

// src/photonUsers.ts
import { existsSync as existsSync2, readdirSync, readFileSync as readFileSync3, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
var API = process.env.PHOTON_API_HOST ?? "https://app.photon.codes";
function dashboardToken() {
  if (process.env.PHOTON_TOKEN) return process.env.PHOTON_TOKEN;
  const roots = [
    process.env.PHOTON_CONFIG_DIR,
    process.env.XDG_CONFIG_HOME && join(process.env.XDG_CONFIG_HOME, "photon"),
    join(homedir(), ".config", "photon")
  ].filter(Boolean);
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 3 || !existsSync2(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p, depth + 1);
      else if (name.endsWith(".json")) {
        try {
          const j = JSON.parse(readFileSync3(p, "utf8"));
          if (typeof j.accessToken === "string" && (!j.apiUrl || String(j.apiUrl).startsWith(API))) found.push({ token: j.accessToken, at: st.mtimeMs });
        } catch {
        }
      }
    }
  };
  roots.forEach((r) => walk(r, 0));
  return found.sort((a, b) => b.at - a.at)[0]?.token;
}
async function addPhotonUser(name, handle2) {
  const token = dashboardToken();
  const projectId = process.env.PHOTON_PROJECT_ID;
  if (!token || !projectId) throw new Error("no-token");
  const [firstName2, ...rest] = name.trim().split(/\s+/);
  const body = { firstName: firstName2 || name, lastName: rest.join(" ") || void 0, sendInvite: false };
  if (handle2.includes("@")) body.email = handle2;
  else body.phoneNumber = handle2;
  const res = await fetch(`${API}/api/projects/${projectId}/spectrum/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15e3)
  });
  const text = await res.text();
  if (res.ok) return "added";
  if (res.status === 409 || /already|exists|duplicate/i.test(text)) return "exists";
  if (res.status === 401) throw new Error("Your Photon login expired. Run `npx -p @photon-ai/cli photon login` again.");
  throw new Error(`Photon said ${res.status}: ${text.slice(0, 160)}`);
}

// src/auth.ts
import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as verifySig } from "node:crypto";
import { Router } from "express";
var SESSION_COOKIE = "cc_session";
var SESSION_DAYS = 30;
var APPLE_ISS = "https://appleid.apple.com";
var GOOGLE_ISS = ["https://accounts.google.com", "accounts.google.com"];
var JWKS = { google: "https://www.googleapis.com/oauth2/v3/certs", apple: "https://appleid.apple.com/auth/keys" };
var load2 = () => get("accounts", { accounts: [], invited: [] });
var save = (a) => put("accounts", a);
var envOwners = () => (process.env.OWNER_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
var b64url = (s) => Buffer.from(s, "base64url");
var keyCache = /* @__PURE__ */ new Map();
async function keysFor(provider, refresh = false) {
  const hit = keyCache.get(provider);
  if (hit && !refresh && Date.now() - hit.at < 36e5) return hit.keys;
  const r = await fetch(JWKS[provider], { signal: AbortSignal.timeout(8e3) });
  if (!r.ok) throw new Error(`couldn't fetch ${provider} keys (${r.status})`);
  const keys = (await r.json()).keys;
  keyCache.set(provider, { at: Date.now(), keys });
  return keys;
}
async function verifyIdToken(provider, token, clientId) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("not a JWT");
  const header = JSON.parse(b64url(parts[0]).toString());
  if (header.alg !== "RS256") throw new Error(`unexpected alg ${header.alg}`);
  let jwk = (await keysFor(provider)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await keysFor(provider, true)).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("unknown signing key");
  const ok = verifySig("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: "jwk" }), b64url(parts[2]));
  if (!ok) throw new Error("bad signature");
  const c = JSON.parse(b64url(parts[1]).toString());
  const issOk = provider === "google" ? GOOGLE_ISS.includes(c.iss) : c.iss === APPLE_ISS;
  if (!issOk) throw new Error("wrong issuer");
  if (!(Array.isArray(c.aud) ? c.aud : [c.aud]).includes(clientId)) throw new Error("token is for another app");
  if (c.exp * 1e3 < Date.now() - 6e4) throw new Error("token expired");
  return c;
}
var devSecret;
function secret() {
  const s = process.env.SESSION_SECRET || process.env.ADMIN_TOKEN;
  if (s) return s;
  return devSecret ??= randomBytes(32).toString("hex");
}
var sign = (body) => createHmac("sha256", secret()).update(body).digest("base64url");
function readSession(req) {
  const raw = (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!raw) return void 0;
  const [body, mac] = decodeURIComponent(raw).split(".");
  if (!body || !mac) return void 0;
  const want = Buffer.from(sign(body));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return void 0;
  const s = JSON.parse(Buffer.from(body, "base64url").toString());
  return s.exp > Date.now() ? s : void 0;
}
function setSession(req, res, s) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  if (!s) {
    res.append("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`);
    return;
  }
  const body = Buffer.from(JSON.stringify(s)).toString("base64url");
  res.append("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(`${body}.${sign(body)}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? "; Secure" : ""}`);
}
function signedIn(req) {
  const s = readSession(req);
  if (!s) return void 0;
  return load2().accounts.find((a) => a.provider === s.p && a.sub === s.sub);
}
function authConfig() {
  const apple = process.env.APPLE_CLIENT_ID;
  return {
    google: process.env.GOOGLE_CLIENT_ID || null,
    apple: apple ? { clientId: apple, redirectURI: process.env.APPLE_REDIRECT_URI || `${(process.env.PUBLIC_URL ?? "").replace(/\/+$/, "")}/login` } : null
  };
}
var landing = () => savedMemberIds().length ? "/dashboard" : "/welcome";
function authRouter(isAdmin2) {
  const r = Router();
  r.get("/api/auth/me", (req, res) => {
    const a = signedIn(req);
    res.json({
      ...authConfig(),
      user: a ? { name: a.name, email: a.email, provider: a.provider, owner: !!a.owner } : null,
      admin: isAdmin2(req),
      claimable: load2().accounts.length === 0 && savedMemberIds().length === 0,
      next: landing()
    });
  });
  r.post("/api/auth/:provider", async (req, res) => {
    const provider = req.params.provider;
    if (provider !== "google" && provider !== "apple") return res.status(404).json({ ok: false });
    const clientId = provider === "google" ? process.env.GOOGLE_CLIENT_ID : process.env.APPLE_CLIENT_ID;
    if (!clientId) return res.json({ ok: false, error: `Sign in with ${provider === "google" ? "Google" : "Apple"} isn't set up on this court yet.` });
    const token = String(req.body?.credential ?? req.body?.id_token ?? "");
    let c;
    try {
      c = await verifyIdToken(provider, token, clientId);
    } catch (err) {
      console.warn(`[auth] ${provider} sign-in rejected:`, err.message);
      return res.json({ ok: false, error: "That sign-in didn't check out. Please try again." });
    }
    const verified = c.email_verified === true || c.email_verified === "true";
    const email = verified ? c.email?.toLowerCase() : void 0;
    const appleName = provider === "apple" ? [req.body?.user?.name?.firstName, req.body?.user?.name?.lastName].filter(Boolean).join(" ") : "";
    const name = c.name || appleName || email?.split("@")[0];
    const all = load2();
    let account = all.accounts.find((a) => a.provider === provider && a.sub === c.sub);
    let firstTime = false;
    if (!account) {
      const invited = !!email && (all.invited.includes(email) || envOwners().includes(email));
      const claim2 = all.accounts.length === 0 && (savedMemberIds().length === 0 || isAdmin2(req));
      if (!invited && !claim2) {
        return res.json({
          ok: false,
          error: `This court already belongs to a family. Ask the parent who set it up to add ${email ?? "your email"} under Settings \u2192 Who can sign in.`
        });
      }
      account = { provider, sub: c.sub, email, name, addedAt: (/* @__PURE__ */ new Date()).toISOString(), owner: claim2 || void 0 };
      all.accounts.push(account);
      if (email) all.invited = all.invited.filter((e) => e !== email);
      save(all);
      firstTime = true;
      console.log(`[auth] ${claim2 ? "owner" : "invited parent"} signed in for the first time: ${email ?? provider}`);
    }
    setSession(req, res, { p: provider, sub: c.sub, email: account.email, name: account.name, exp: Date.now() + SESSION_DAYS * 864e5 });
    res.json({ ok: true, firstTime, next: firstTime && !savedMemberIds().length ? "/welcome" : typeof req.body?.next === "string" && req.body.next.startsWith("/") && !req.body.next.startsWith("//") ? req.body.next : landing() });
  });
  r.post("/api/auth/logout", (req, res) => {
    setSession(req, res, void 0);
    res.json({ ok: true });
  });
  r.get("/api/auth/accounts", (req, res) => {
    if (!isAdmin2(req)) return res.status(403).json({ ok: false });
    const me = signedIn(req);
    const a = load2();
    res.json({
      accounts: a.accounts.map((x) => ({ id: `${x.provider}:${x.sub}`, name: x.name, email: x.email, provider: x.provider, owner: !!x.owner, you: x === me || me && x.sub === me.sub && x.provider === me.provider })),
      invited: a.invited,
      fromEnv: envOwners()
    });
  });
  r.post("/api/auth/invite", (req, res) => {
    if (!isAdmin2(req)) return res.status(403).json({ ok: false });
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.json({ ok: false, error: "Enter an email address, like rosa@gmail.com." });
    const a = load2();
    if (a.accounts.some((x) => x.email === email)) return res.json({ ok: false, error: `${email} can already sign in.` });
    if (!a.invited.includes(email)) a.invited.push(email);
    save(a);
    res.json({ ok: true, invited: a.invited });
  });
  r.post("/api/auth/remove", (req, res) => {
    if (!isAdmin2(req)) return res.status(403).json({ ok: false });
    const id = String(req.body?.id ?? "");
    const email = String(req.body?.email ?? "").toLowerCase();
    const a = load2();
    const me = signedIn(req);
    if (me && id === `${me.provider}:${me.sub}`) return res.json({ ok: false, error: "You can't remove yourself. Sign out instead." });
    a.accounts = a.accounts.filter((x) => `${x.provider}:${x.sub}` !== id);
    if (email) a.invited = a.invited.filter((e) => e !== email);
    save(a);
    res.json({ ok: true });
  });
  return r;
}

// src/setup.ts
var envFile = fileURLToPath3(new URL("../.env", import.meta.url));
var exampleFile = fileURLToPath3(new URL("../.env.example", import.meta.url));
var EDITABLE = ["GEMINI_API_KEY", "GEMINI_MODELS", "PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET", "PUBLIC_URL", "COURT_NUMBER", "MONGODB_URI"];
function writeEnv(updates) {
  const base2 = existsSync3(envFile) ? readFileSync4(envFile, "utf8") : readFileSync4(exampleFile, "utf8");
  const lines = base2.split(/\r?\n/);
  for (const [k, v] of Object.entries(updates)) {
    if (v === void 0) continue;
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
    process.env[k] = v;
  }
  try {
    writeFileSync2(envFile, lines.join("\n"));
  } catch (err) {
    console.warn(`[setup] couldn't save .env (${err.message}). Set these in your host's environment variables: ${Object.keys(updates).join(", ")}`);
  }
}
function isLocal(req) {
  const ip = req.socket.remoteAddress ?? "";
  const loopback = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  const host = (req.headers.host ?? "").split(":")[0];
  const forwarded = req.headers["x-forwarded-for"] || req.headers["cf-connecting-ip"] || req.headers["forwarded"];
  return loopback && (host === "localhost" || host === "127.0.0.1") && !forwarded;
}
var ADMIN_COOKIE = "cc_admin";
var sameSecret = (a, b) => timingSafeEqual2(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
var adminCookie = (req) => (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${ADMIN_COOKIE}=`))?.slice(ADMIN_COOKIE.length + 1);
function isAdmin(req) {
  if (isLocal(req)) return true;
  if (signedIn(req)) return true;
  const token = process.env.ADMIN_TOKEN;
  const cookie = adminCookie(req);
  return !!token && !!cookie && sameSecret(decodeURIComponent(cookie), token);
}
function adminLogin(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  const key = typeof req.query.key === "string" ? req.query.key : void 0;
  if (!token || !key || req.method !== "GET") return next();
  if (!sameSecret(key, token)) return res.status(403).send("That admin key isn't right.");
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.setHeader("Set-Cookie", `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure ? "; Secure" : ""}`);
  const url = new URL(req.originalUrl, "http://x");
  url.searchParams.delete("key");
  res.redirect(url.pathname + url.search);
}
function localOnly(req, res, next) {
  if (isAdmin(req)) return next();
  if (req.method === "GET" && !req.originalUrl.startsWith("/api/") && req.accepts("html")) {
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  res.status(403).send("This page only works on the computer running Cart Court (http://localhost:3000), or on a hosted court after opening its admin link (/?key=\u2026). The family's case file is at /cart.");
}
var mask = (v) => v ? `\u2022\u2022\u2022\u2022${v.slice(-4)}` : "";
var setupRouter = Router2();
setupRouter.use(adminLogin);
setupRouter.use(["/setup", "/setup.html", "/api/setup", "/dashboard", "/dashboard.html", "/api/dashboard", "/sim", "/sim.html", "/api/sim", "/api/demo", "/welcome", "/welcome.html", "/api/guide"], localOnly);
setupRouter.get("/api/guide", (_req, res) => {
  const saved = savedMemberIds();
  const members = world.household.members.filter((m) => saved.includes(m.id));
  res.json({
    household: { saved: members.length, withNumbers: members.filter((m) => m.handles.length).length, names: members.map((m) => m.name) },
    budget: state.budget ?? null,
    gemini: !!process.env.GEMINI_API_KEY,
    photon: {
      configured: !!(process.env.PHOTON_PROJECT_ID && process.env.PHOTON_PROJECT_SECRET),
      state: photonStatus.state,
      error: photonStatus.error,
      line: photonStatus.line ?? process.env.COURT_NUMBER ?? "",
      autoUsers: !!dashboardToken(),
      // the court can add numbers under Photon's Users by itself
      // Hosted (Vercel): keys live in the host's environment variables and messages arrive by webhook.
      hosted: serverless,
      webhook: !!process.env.SPECTRUM_WEBHOOK_SECRET,
      publicUrl: process.env.PUBLIC_URL ?? ""
    },
    // The numbers Photon's free plan has to list under Users before the court can text them.
    numbers: members.flatMap((m) => m.handles.map((handle2) => ({ name: m.name, handle: handle2, welcomed: welcomed.includes(handle2) }))),
    welcomed: members.filter((m) => m.handles.some((h) => welcomed.includes(h))).length,
    database: backend
  });
});
setupRouter.get("/api/setup", (_req, res) => {
  res.json({
    gemini: { configured: !!process.env.GEMINI_API_KEY, hint: mask(process.env.GEMINI_API_KEY), models: process.env.GEMINI_MODELS ?? "" },
    photon: {
      configured: !!(process.env.PHOTON_PROJECT_ID && process.env.PHOTON_PROJECT_SECRET),
      ...photonStatus,
      projectHint: mask(process.env.PHOTON_PROJECT_ID),
      autoUsers: !!dashboardToken()
      // can the court add numbers under Users by itself?
    },
    publicUrl: process.env.PUBLIC_URL ?? "",
    courtNumber: process.env.COURT_NUMBER ?? ""
  });
});
setupRouter.post("/api/setup", async (req, res) => {
  const body = req.body;
  const updates = {};
  for (const k of EDITABLE) {
    const v = typeof body[k] === "string" ? body[k].trim() : void 0;
    if (v) updates[k] = k === "PUBLIC_URL" ? v.replace(/\/+$/, "") : v;
  }
  const photonChanged = updates.PHOTON_PROJECT_ID && updates.PHOTON_PROJECT_ID !== process.env.PHOTON_PROJECT_ID || updates.PHOTON_PROJECT_SECRET && updates.PHOTON_PROJECT_SECRET !== process.env.PHOTON_PROJECT_SECRET;
  writeEnv(updates);
  if (photonChanged || (updates.PHOTON_PROJECT_ID || updates.PHOTON_PROJECT_SECRET) && photonStatus.state !== "connected") {
    startPhoton().catch((err) => console.error("[photon] restart failed:", err));
    await new Promise((r) => setTimeout(r, 2500));
  }
  res.json({ ok: true, saved: Object.keys(updates) });
});
setupRouter.post("/api/setup/test-gemini", async (_req, res) => {
  if (!process.env.GEMINI_API_KEY) return res.json({ ok: false, error: "No Gemini key saved yet." });
  const models2 = (process.env.GEMINI_MODELS || "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash").split(",");
  const ai2 = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  let lastError = "";
  for (const model of models2.map((m) => m.trim())) {
    try {
      const r = await ai2.models.generateContent({ model, contents: "Reply with exactly: Order in the court.", config: { abortSignal: AbortSignal.timeout(15e3) } });
      return res.json({ ok: true, model, reply: r.text?.trim() });
    } catch (err) {
      lastError = String(err.message ?? err);
      if (/402|prepayment/i.test(lastError) || !/429|RESOURCE_EXHAUSTED|abort|timed? ?out/i.test(lastError)) break;
    }
  }
  res.json({ ok: false, error: /402|prepayment/i.test(lastError) ? "This key's project is on prepaid billing with no credits left. Open ai.studio/projects, pick this key's project, and add credits or apply your promo credits there. (Until then the court uses rules mode.)" : /API key not valid|API_KEY_INVALID/i.test(lastError) ? "That key isn't valid. Copy it again from aistudio.google.com/apikey." : /429|RESOURCE_EXHAUSTED/.test(lastError) ? "The key works, but today's free quota is used up on every model." : lastError.slice(0, 200) });
});
setupRouter.post("/api/setup/hello", async (req, res) => {
  const phone2 = String(req.body?.phone ?? "").trim();
  if (!/^\+?[\d\s().-]{7,}$|^\S+@\S+$/.test(phone2)) return res.json({ ok: false, error: "Enter a phone number like +1 206 555 0123 (or your iMessage email)." });
  const handle2 = phone2.includes("@") ? phone2 : `+${phone2.replace(/\D/g, "").replace(/^(\d{10})$/, "1$1")}`;
  try {
    console.log(`[photon] Text me -> ${handle2}`);
    const r = await sayHello(handle2);
    console.log(`[photon] sent to ${handle2}${r.line ? ` from ${r.line}` : ""}`);
    if (r.line && !process.env.COURT_NUMBER) writeEnv({ COURT_NUMBER: r.line });
    res.json({ ok: true, handle: handle2, line: r.line });
  } catch (err) {
    const msg = String(err.message ?? err);
    console.error(`[photon] Text me to ${handle2} failed:`, msg);
    res.json({
      ok: false,
      handle: handle2,
      error: /not allowed|allowlist/i.test(msg) ? `Photon won't text ${handle2} yet. Add it under Users in the Photon dashboard (app.photon.codes), then try again.` : msg.slice(0, 240)
    });
  }
});
function normalizeHandle(raw) {
  const v = raw.trim();
  if (!v) return void 0;
  if (v.includes("@")) return /^\S+@\S+\.\S+$/.test(v) ? v.toLowerCase() : void 0;
  const d = v.replace(/\D/g, "");
  if (d.length < 7) return void 0;
  return `+${d.length === 10 ? `1${d}` : d}`;
}
var ROLES = ["parent", "teen", "kid", "grandparent", "roommate", "partner", "other"];
setupRouter.get("/api/setup/household", (_req, res) => {
  const example = loadWorld({ local: false }).household;
  const saved = loadHouseholdLocal().members;
  res.json({
    roles: ROLES,
    phones: [.../* @__PURE__ */ new Set([...example.members.map((m) => m.device.model), ...world.catalog.phones.map((p) => p.name)])],
    members: world.household.members.map((m) => {
      const ex = example.members.find((x) => x.id === m.id);
      const s = saved[m.id];
      return {
        id: m.id,
        saved: !!s,
        example: { name: ex.name, role: ex.role, phoneModel: ex.device.model, batteryHealth: ex.device.batteryHealth },
        name: s?.name ?? "",
        role: s?.role ?? "",
        phoneModel: s?.phoneModel ?? "",
        batteryHealth: s?.batteryHealth ?? null,
        handle: s?.handles?.[0] ?? claimedHandles(m.id)[0] ?? ""
      };
    })
  });
});
setupRouter.post("/api/setup/household", (req, res) => {
  const input = req.body?.members ?? [];
  const local = loadHouseholdLocal();
  const problems = [];
  for (const row of input) {
    if (!world.household.members.some((x) => x.id === row.id)) continue;
    const name = (row.name ?? "").trim();
    const phone2 = (row.phone ?? "").trim();
    if (!name && !phone2) {
      delete local.members[row.id];
      continue;
    }
    if (!name) {
      problems.push(`Add a name for ${phone2}`);
      continue;
    }
    const handle2 = phone2 ? normalizeHandle(phone2) : void 0;
    if (phone2 && !handle2) problems.push(`${name}: "${phone2}" isn't a phone number or email`);
    local.members[row.id] = {
      name,
      handles: handle2 ? [handle2] : local.members[row.id]?.handles ?? [],
      role: ROLES.includes(row.role ?? "") ? row.role : void 0,
      phoneModel: (row.phoneModel ?? "").trim() || void 0,
      batteryHealth: (() => {
        const b = Math.round(Number(row.batteryHealth));
        return b >= 1 && b <= 100 ? b : void 0;
      })()
    };
  }
  saveHouseholdLocal(local);
  const fresh2 = loadWorld().household.members;
  for (const m of world.household.members) {
    const f = fresh2.find((x) => x.id === m.id);
    m.name = f.name;
    m.role = f.role;
    m.handles = f.handles;
    m.device.model = f.device.model;
    m.device.batteryHealth = f.device.batteryHealth;
  }
  changed();
  res.json({ ok: problems.length === 0, problems, saved: Object.keys(local.members).length });
});
var welcomed = get("welcomed", []);
onReload(() => welcomed.splice(0, welcomed.length, ...get("welcomed", [])));
var wasWelcomed = (handle2) => welcomed.includes(handle2);
setupRouter.post("/api/setup/hello-all", async (req, res) => {
  const resend = req.body?.resend === true;
  const saved = savedMemberIds();
  const canRegister = !!dashboardToken();
  const targets2 = world.household.members.filter((m) => saved.includes(m.id)).flatMap((m) => m.handles.map((handle2) => ({ name: m.name, handle: handle2 })));
  const todo = resend ? targets2 : targets2.filter((t) => !welcomed.includes(t.handle));
  const skipped = targets2.length - todo.length;
  const results = await Promise.all(
    todo.map(async ({ name, handle: handle2 }) => {
      try {
        if (canRegister) {
          await addPhotonUser(name, handle2).catch((e) => console.warn(`[photon] couldn't add ${handle2} under Users:`, e.message));
        }
        const r = await sayHello(handle2);
        if (r.line && !process.env.COURT_NUMBER) writeEnv({ COURT_NUMBER: r.line });
        if (!welcomed.includes(handle2)) welcomed.push(handle2);
        console.log(`[photon] welcomed ${name} at ${handle2}`);
        return { name, handle: handle2, ok: true };
      } catch (err) {
        const msg = String(err.message ?? err);
        console.error(`[photon] welcome to ${name} (${handle2}) failed:`, msg);
        return {
          name,
          handle: handle2,
          ok: false,
          error: /not allowed|allowlist/i.test(msg) ? canRegister ? "Photon hasn't approved this number yet. Try again in a minute" : "not approved in Photon yet (see the tip above)" : msg.slice(0, 160)
        };
      }
    })
  );
  put("welcomed", welcomed);
  res.json({ ok: results.every((r) => r.ok), results, skipped, total: targets2.length, line: photonStatus.line, canRegister });
});
var mongoHost = (uri2) => uri2?.match(/@([^/?]+)/)?.[1] ?? "";
setupRouter.get("/api/setup/db", (_req, res) => {
  res.json({ backend, host: backend === "mongodb" ? mongoHost(process.env.MONGODB_URI) : "", configured: !!process.env.MONGODB_URI });
});
setupRouter.post("/api/setup/mongodb", async (req, res) => {
  const uri2 = String(req.body?.uri ?? "").trim();
  if (!/^mongodb(\+srv)?:\/\//.test(uri2)) {
    return res.json({ ok: false, error: "That doesn't look like a MongoDB connection string. It should start with mongodb+srv://" });
  }
  if (/<(db_)?password>/i.test(uri2)) {
    return res.json({ ok: false, error: "Replace <db_password> in the string with the database user's password you created." });
  }
  try {
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(uri2, { serverSelectionTimeoutMS: 1e4, appName: "cart-court-setup" });
    await client.connect();
    await client.db(process.env.MONGODB_DB || "cartcourt").command({ ping: 1 });
    await client.close();
  } catch (err) {
    const msg = String(err.message ?? err);
    console.warn("[db] connection test failed:", msg);
    return res.json({
      ok: false,
      error: /auth|authentication|bad auth/i.test(msg) ? "Wrong username or password. In Atlas \u2192 Database Access, check the user (or reset its password) and paste the string again." : /ENOTFOUND|querySrv|ENODATA/i.test(msg) ? "Couldn't find that cluster address. Copy the whole connection string again from Atlas \u2192 Connect \u2192 Drivers." : /timed out|Server selection|ETIMEDOUT|ECONNREFUSED|ReplicaSetNoPrimary/i.test(msg) ? "Couldn't reach the cluster. In Atlas \u2192 Network Access, add your current IP address (for the hackathon, 0.0.0.0/0 also works), wait a minute, then try again." : msg.slice(0, 200)
    });
  }
  writeEnv({ MONGODB_URI: uri2 });
  await flush();
  const watching = process.execArgv.some((a) => a.startsWith("--watch"));
  if (watching) {
    setTimeout(() => {
      const now = /* @__PURE__ */ new Date();
      utimesSync(fileURLToPath3(new URL("./db.ts", import.meta.url)), now, now);
    }, 400);
  }
  res.json({ ok: true, host: mongoHost(uri2), restarting: watching });
});

// src/share.ts
var shareRouter = Router3();
var publicUrl = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.headers.host}`).replace(/\/$/, "");
var courtNumber = () => process.env.COURT_NUMBER || photonStatus.line || "";
var FIRST_TEXT = "court, what phone should I get?";
function targets(req) {
  const number = courtNumber();
  return {
    cart: `${publicUrl(req)}/cart`,
    text: number && isAdmin(req) ? `sms:${number.replace(/[^\d+]/g, "")}&body=${encodeURIComponent(FIRST_TEXT)}` : void 0
  };
}
shareRouter.get("/api/share", (req, res) => {
  const t = targets(req);
  res.json({ cartUrl: t.cart, textUrl: t.text, courtNumber: t.text ? courtNumber() : void 0, firstText: FIRST_TEXT });
});
shareRouter.get("/api/qr", async (req, res) => {
  const which = req.query.for === "text" ? "text" : "cart";
  const data = targets(req)[which];
  if (!data) return res.status(404).send("Nothing to encode (texting the court needs COURT_NUMBER and the admin view).");
  const svg = await QRCode.toString(data, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#1d1a16", light: "#fffdf8" } });
  res.type("image/svg+xml").set("Cache-Control", "no-store").send(svg);
});
var page;
var esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
var base = () => process.env.PUBLIC_URL ?? "http://localhost:3000";
var household = () => world.household.name.replace(/^The /, "the ");
var first = (id) => (world.household.members.find((m) => m.id === id)?.name ?? "").split(/\s+/)[0];
var caseFileUrl = () => `${base()}/case${state.trial ? `?v=${state.trial.day}-${state.trial.savings}` : ""}`;
function preview() {
  const t = state.trial;
  const n = state.cart.filter((i) => i.kind !== "addon").length;
  const allPhones = state.cart.every((i) => i.kind !== "product" && i.kind !== "accessory");
  const what = (k) => `${k} ${allPhones ? "phone" : "item"}${k === 1 ? "" : "s"}`;
  if (!t) {
    return {
      title: `${world.household.name}: ${n ? `${what(n)} awaiting the court` : "case file"}`,
      description: n ? `Nobody checks out until the court rules. Text "court, rule" when everyone's in.` : "Everything in the family cart, on trial. Buy now, wait, or skip, with the math."
    };
  }
  const people = t.rulings.filter((r) => r.memberId && r.proposed).map((r) => r.stamp === "WAIT" ? `${first(r.memberId)} waits till day ${r.holdUntilDay}` : r.stamp === "KEEP" || r.stamp === "SWAP" ? `${first(r.memberId)} buys today` : `${first(r.memberId)}: ${r.stamp.toLowerCase()}`);
  return {
    title: t.savings > 0 ? `The court saved ${household()} ${usd(t.savings)}` : `${world.household.name}: the court has ruled`,
    description: [people.join(" \xB7 "), `Spend today ${usd(t.before)} \u2192 ${usd(t.now)}`].filter(Boolean).join(". ")
  };
}
function caseFileHtml() {
  const { title, description } = preview();
  const meta = [
    ["og:type", "website"],
    ["og:site_name", "Cart Court"],
    ["og:title", title],
    ["og:description", description],
    ["og:image", `${base()}/og-card.png`],
    ["og:image:width", "1200"],
    ["og:image:height", "630"],
    ["og:url", `${base()}/case`]
  ].map(([p, c]) => `  <meta property="${p}" content="${esc(c)}" />`).join("\n");
  page ??= readFileSync5(fileURLToPath4(new URL("../public/cart.html", import.meta.url)), "utf8");
  return page.replace(/<title>[^<]*<\/title>/, (title2) => `${title2}
  <meta name="description" content="${esc(description)}" />
${meta}
  <meta name="twitter:card" content="summary_large_image" />`);
}
shareRouter.get(["/case", "/cart", "/cart.html"], (_req, res) => {
  res.type("html").set("Cache-Control", "no-cache").send(caseFileHtml());
});

// src/tools.ts
function resolveMember(nameOrId) {
  const q = String(nameOrId).toLowerCase().trim();
  const m = world.household.members.find(
    (x) => x.id === q || x.name.toLowerCase() === q || x.role === q || q === "dad" && x.id === "marco" || q === "mom" && x.id === "elena" || q === "grandma" && x.role === "grandparent"
  );
  if (!m) throw new Error(`No household member "${nameOrId}". Members: ${world.household.members.map((x) => x.name).join(", ")}`);
  return m;
}
var STAMP_ICON = { KEEP: "\u2705", SWAP: "\u{1F501}", WAIT: "\u23F3", CUT: "\u2702\uFE0F", STAY: "\u{1F3E0}", LEAVE: "\u{1F6AA}" };
var firstName = (label) => label.split(" \xB7 ")[0].split(/\s+/)[0];
function rulingLine(r, day, hasProtection = false) {
  const who = r.memberId ? `${firstName(r.label)} \xB7 ` : "";
  const item = r.proposed?.label ?? r.label.split(" \xB7 ").slice(1).join(" \xB7 ");
  const was = r.label.split(" \xB7 ").slice(1).join(" \xB7 ");
  const swapped = r.proposed && !r.label.endsWith(r.proposed.label) ? ` (instead of ${was})` : "";
  const save2 = r.savings > 0 ? ` \xB7 saves ${usd(r.savings)}` : "";
  const shield = r.protection?.verdict === "ADD" && !hasProtection ? " \xB7 \u{1F6E1}\uFE0F add protection" : "";
  const mo = (n) => r.memberId && n > 0 ? ` \xB7 \u2248${usd(perMonth(n))}/mo` : "";
  const ti = r.tradeIn ? ` with trade-in (${usd(r.tradeIn.withoutTradeIn)} without)` : "";
  switch (r.stamp) {
    case "KEEP":
    case "SWAP":
      return `\u2705 BUY: ${who}${r.memberId ? item : r.label.split(" \xB7 ").slice(1).join(" \xB7 ")}${swapped} \xB7 ${usd(r.nowCost)} today${ti}${mo(r.nowCost)}${save2}${shield}`;
    case "WAIT": {
      const days = (r.holdUntilDay ?? day) - day;
      return `\u23F3 WAIT ${days} day${days === 1 ? "" : "s"}: ${who}${item}${swapped} \xB7 ${usd(r.heldCost)} on day ${r.holdUntilDay}${ti}${mo(r.heldCost)}${save2}${shield}`;
    }
    case "CUT":
      return `\u2702\uFE0F SKIP: ${r.label.split(" \xB7 ").slice(1).join(" \xB7 ") || r.label}${save2 ? `${save2}/yr` : ""}`;
    default:
      return `${STAMP_ICON[r.stamp]} ${r.stamp}: ${r.label}`;
  }
}
function formatVerdict(t) {
  const planned = t.planned ?? t.now + t.held;
  const budget = t.budget === void 0 ? [] : t.overBudget ? [`\u{1F4B0} Budget: this plan (${usd(planned)} now + later) is ${usd(planned - t.budget)} over what's left (${usd(t.budget)})`] : [`\u{1F4B0} Budget: this plan uses ${usd(planned)} (now + later), leaving ${usd(t.budget - planned)}`];
  return [
    "\u2696\uFE0F THE COURT RULES",
    ...t.rulings.map((r) => rulingLine(r, t.day, t.rulings.some((x) => x.memberId === r.memberId && x.label.includes("Protection")))),
    `Spend today: ${usd(t.before)} \u2192 ${usd(t.now)} \xB7 You save ${usd(t.savings)}`,
    ...budget,
    // Someone is told to wait or to pick a different phone: show them the no-typing way to push back.
    ...t.rulings.some((r) => r.proposed && r.stamp !== "KEEP" && !r.overruled) ? ["Disagree? Tap \u{1F44E} on this to appeal, or \u2753 to ask why."] : [],
    `Case file: ${caseFileUrl()}`
  ].join("\n");
}
var promoLine = (p) => `${p.name}: ${p.percentOff ? `${p.percentOff}% off` : `\u2212${usd(p.credit ?? 0)}`} (days ${p.startsOnDay}-${p.endsOnDay})`;
function formatMonthly() {
  const rulings = state.trial?.rulings ?? [];
  if (!rulings.length) return `\u{1F4B5} Nothing's ruled yet, so there's no monthly number. Say "court, rule" and the court will do the math.`;
  const lines = [];
  let total = 0;
  for (const r of rulings) {
    if (r.stamp === "CUT") continue;
    const price = r.stamp === "WAIT" ? r.heldCost : r.nowCost;
    if (r.memberId && price > 0) {
      total += perMonth(price);
      lines.push(`\u2022 ${firstName(r.label)}'s ${r.proposed?.label ?? r.label.split(" \xB7 ").slice(1).join(" \xB7 ")}: \u2248${usd(perMonth(price))}/mo${r.stamp === "WAIT" ? ` from day ${r.holdUntilDay}` : ""}`);
    }
  }
  const cut = rulings.filter((r) => r.stamp === "CUT").reduce((s, r) => s + r.savings, 0);
  return [
    `\u{1F4B5} New phones, about ${usd(total)}/mo together (24 payments, after trade-ins and deals):`,
    ...lines,
    ...cut > 0 ? [`Skipping the add-ons the court cut takes \u2248${usd(Math.round(cut / 12))}/mo off the bill.`] : []
  ].join("\n");
}
function formatOldPhone(asker) {
  if (!asker) return `\u{1F4F1} Text from your own phone and the court will tell you what happens to it.`;
  const m = member(world, asker);
  const first4 = m.name.split(/\s+/)[0];
  const rulings = state.trial?.rulings ?? [];
  const mine = rulings.find((r) => r.memberId === asker && r.stamp !== "CUT");
  if (!mine) return `\u{1F4F1} Your ${m.device.model} stays with you: nothing's ruled for ${first4} yet.`;
  const passed = rulings.find((r) => r.handMeDown?.from === asker && r.handMeDown.saves > 0);
  if (passed) return `\u{1F4F1} ${handMeDownText(world, passed)}.`;
  if (mine.tradeIn) {
    const when = mine.stamp === "WAIT" ? `on day ${mine.holdUntilDay}` : "today";
    return `\u{1F4F1} Trade it in ${when}: your ${mine.tradeIn.device} is worth ${usd(mine.tradeIn.value)}, already counted in the ${usd(mine.tradeIn.withTradeIn)} price (${usd(mine.tradeIn.withoutTradeIn)} if you keep it as a backup).`;
  }
  return `\u{1F4F1} Keep your ${m.device.model}: it's worth nothing as a trade-in, so it makes a good backup.`;
}
function formatStatus(asker) {
  const sticker2 = (i) => i.kind === "device" ? phone(world, i.phoneId).prices[String(i.storageGB)] ?? 0 : i.kind === "accessory" ? (world.catalog.accessories ?? []).find((a) => a.id === i.accessoryId)?.price ?? 0 : 0;
  const perMonth2 = (i) => i.kind === "addon" ? world.catalog.addons.find((a) => a.id === i.addonId)?.monthly : void 0;
  const ruling = (id) => state.trial?.rulings.find((r) => r.itemId === id);
  const unruled = state.cart.filter((i) => !ruling(i.id));
  const lines = state.cart.map((i) => {
    const r = ruling(i.id);
    const price = perMonth2(i) !== void 0 ? `${usd(perMonth2(i))}/mo` : usd(sticker2(i));
    const mine = i.memberId === asker ? " (yours)" : "";
    const where = !r ? "not ruled yet" : r.stamp === "WAIT" ? `\u23F3 wait till day ${r.holdUntilDay}${r.proposed && !r.label.endsWith(r.proposed.label) ? `, the ${r.proposed.label}` : ""}: ${usd(r.heldCost)}` : r.stamp === "KEEP" || r.stamp === "SWAP" ? `\u2705 buy${r.proposed && !r.label.endsWith(r.proposed.label) ? ` the ${r.proposed.label}` : ""}: ${usd(r.nowCost)}` : r.stamp === "CUT" ? "\u2702\uFE0F skip" : r.stamp;
    return `\u2022 ${cartItemLabel(i)}${mine}, ${price} \xB7 ${where}`;
  });
  const total = state.cart.reduce((s, i) => s + sticker2(i), 0);
  const bought = state.purchases.slice(-3).map((p) => `${member(world, p.memberId).name.split(/\s+/)[0]}'s ${p.label} (${usd(p.paid)})`);
  return [
    state.cart.length ? `\u{1F6D2} Family cart, day ${state.day}: ${state.cart.length} item${state.cart.length === 1 ? "" : "s"}, sticker ${usd(total)}` : "\u{1F6D2} The family cart is empty.",
    ...lines,
    ...bought.length ? [`\u{1F9FE} Bought: ${bought.join(", ")}`] : [],
    !state.cart.length ? 'Paste a store link or ask "what phone should I get?" to start.' : unruled.length ? `When everyone's in, say "court, rule".` : `Case file: ${caseFileUrl()}`
  ].join("\n");
}
var tools = {
  get_household: {
    description: "Who is on the plan, their current phones (age, battery health, storage used, payments left, trade-in value), other things they already own (TV, laptop, vacuum\u2026), account add-ons, the product categories the store carries, and today's demo day.",
    params: {},
    run: () => ({
      day: state.day,
      household: world.household.name,
      members: world.household.members.map((m) => ({ id: m.id, name: m.name, role: m.role, age: m.age, usage: m.usage, device: m.device })),
      owned: world.household.owned ?? [],
      accountAddons: world.household.accountAddons,
      categories: Object.entries(categories(world)).map(([id, c]) => `${id} (${c.label})`)
    })
  },
  recommend_phones: {
    description: "Matchmaker: top 3 phones for a member, based on how they use their phone AND what they said they care about. Pass `wants` whenever they mention battery life, screen size, camera, gaming, simplicity or price; it's remembered for next time.",
    params: {
      member: { type: "string", description: "member name or id" },
      wants: {
        type: "array",
        items: { type: "string", enum: ["battery", "bigScreen", "smallScreen", "camera", "gaming", "simple", "cheap"] },
        description: "what they said matters to them"
      },
      brand: { type: "string", enum: ["Apple", "Google", "Samsung"], description: "only if they named a brand" },
      budget: { type: "number", description: "max price in USD, if they gave one" }
    },
    required: ["member"],
    run: (a) => {
      const m = resolveMember(a.member);
      const said = {};
      for (const w of a.wants ?? []) if (w in PREF_LABELS) said[w] = true;
      if (a.brand) said.brand = a.brand;
      if (a.budget) said.budget = a.budget;
      const prefs = state.prefs[m.id] = mergePrefs(state.prefs[m.id], said);
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
            withTradeIn: tradeIn(m).value > 0 ? { price: Math.max(0, r.price - tradeIn(m).value), tradeIn: m.device.model } : void 0,
            priceDrop: track.lowest.price < track.now ? { price: track.lowest.price, inDays: track.lowest.day - state.day } : void 0,
            promos: promosFor(world, r.phoneId, state.day).map(promoLine)
          };
        })
      };
    }
  },
  recommend_products: {
    description: "Matchmaker for anything that isn't a phone (laptops, TVs, headphones, game consoles, vacuums, kitchen appliances, chairs, mattresses, shoes, jackets\u2026): top 3 in a category with prices, upcoming sales and protection advice.",
    params: {
      member: { type: "string", description: "member name or id" },
      category: { type: "string", description: `a category id (${Object.keys(categories(world)).join(", ")}) or what they called it ("laptop", "air fryer")` },
      budget: { type: "number", description: "max price in USD, if they gave one" },
      brand: { type: "string", description: "only if they named a brand" },
      cheap: { type: "boolean", description: "they care most about price" },
      best: { type: "boolean", description: "they want the best, price matters less" }
    },
    required: ["member", "category"],
    run: (a) => {
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
          const track = priceTrack(world, r.productId, r.variant, state.day, 90);
          return {
            ...r,
            protection: cat.fragile ? productProtection(m, r.price) : void 0,
            priceDrop: track.lowest.price < track.now ? { price: track.lowest.price, inDays: track.lowest.day - state.day } : void 0,
            promos: promosFor(world, r.productId, state.day, category).map(promoLine)
          };
        })
      };
    }
  },
  add_product_to_cart: {
    description: "Add anything that isn't a phone to the shared cart: a catalog product (id or loose name like 'macbook air', 'lg oled 65') or, if the store doesn't carry it, a custom item with the name and the price the person gave (never guess a price).",
    params: {
      member: { type: "string" },
      product: { type: "string", description: "catalog id or name, or what the item is" },
      variant: { type: "string", description: "size/config if they said one: '65in', '1TB', 'Queen'" },
      quantity: { type: "number", description: "how many (default 1)" },
      price: { type: "number", description: "USD per item; only for items not in the catalog, as the person stated it" },
      category: { type: "string", description: "for custom items: the closest category id, if any" },
      url: { type: "string", description: "for custom items: the store link they pasted, if any" },
      addedBy: { type: "string", description: "who asked" }
    },
    required: ["member", "product"],
    run: (a) => {
      const m = resolveMember(a.member);
      const products = world.catalog.products ?? [];
      const p = products.find((x) => x.id === a.product) ?? bestMatch(products, a.product)?.item;
      const quantity = Math.max(1, Math.round(a.quantity ?? 1));
      if (p) {
        const variant = a.variant && a.variant in p.prices ? a.variant : pickVariant(p, `${a.variant ?? ""} ${a.product}`);
        const item2 = { id: newId("c"), kind: "product", memberId: m.id, productId: p.id, variant, quantity, addedBy: a.addedBy };
        state.cart.push(item2);
        refreshTrial();
        changed();
        return { added: `${cartLabel(world, item2)} for ${m.name}`, price: cartPrice(world, item2), itemId: item2.id };
      }
      if (!(a.price && a.price > 0)) {
        throw new Error(`"${a.product}" isn't in the catalog. Ask what it costs, then add it with that price.`);
      }
      const category = a.category && a.category in categories(world) ? a.category : findCategory(world, a.product);
      const item = { id: newId("c"), kind: "product", memberId: m.id, custom: { name: a.product, price: Math.round(a.price), category }, url: /^https?:\/\//.test(a.url ?? "") ? a.url : void 0, quantity, addedBy: a.addedBy };
      state.cart.push(item);
      refreshTrial();
      changed();
      return { added: `${cartLabel(world, item)} for ${m.name}`, price: cartPrice(world, item), itemId: item.id };
    }
  },
  report_owned_item: {
    description: "Someone says something about a thing they already own that isn't their phone: 'the vacuum died', 'my laptop is 6 years old', 'our TV still works fine'. Updates what the rulings use (a broken one is replaced now; a working one can wait).",
    params: {
      member: { type: "string", description: "whose it is; omit for something the household shares" },
      category: { type: "string", description: "category id or what it is ('tv', 'laptop', 'vacuum')" },
      name: { type: "string", description: "what it is, e.g. 'old Hoover upright'" },
      ageMonths: { type: "number" },
      broken: { type: "boolean" }
    },
    required: ["category"],
    run: (a) => {
      const m = a.member ? resolveMember(a.member) : void 0;
      const category = a.category in categories(world) ? a.category : findCategory(world, `${a.category} ${a.name ?? ""}`);
      if (!category) throw new Error(`Unknown category "${a.category}"`);
      const owned = world.household.owned ??= [];
      let o = owned.find((x) => x.category === category && (x.memberId === m?.id || !x.memberId));
      if (!o) owned.push(o = { id: newId("o"), memberId: m?.id, category, name: a.name ?? `old ${categories(world)[category].label}`, ageMonths: a.ageMonths ?? 0 });
      if (a.name) o.name = a.name;
      if (typeof a.ageMonths === "number" && a.ageMonths >= 0) o.ageMonths = Math.round(a.ageMonths);
      if (typeof a.broken === "boolean") o.broken = a.broken;
      refreshTrial();
      changed();
      const item = state.cart.find((c) => c.kind === "product" && (!m || c.memberId === m.id) && (c.custom?.category ?? world.catalog.products?.find((p) => p.id === c.productId)?.category) === category);
      const ruling = state.trial?.rulings.find((r) => r.itemId === item?.id);
      return {
        owned: o,
        updatedRuling: ruling ? { stamp: ruling.stamp, reasons: ruling.reasons, nowCost: ruling.nowCost } : "no trial yet; it will count when the cart goes on trial"
      };
    }
  },
  add_recommended: {
    description: "Add one of the phones, products or accessories just recommended to the cart: 'add the first one' = pick 1.",
    params: { member: { type: "string" }, pick: { type: "number", description: "1, 2 or 3" } },
    required: ["member", "pick"],
    run: (a) => {
      const m = resolveMember(a.member);
      const r = state.lastRecs[m.id]?.[Math.max(1, Math.min(3, a.pick)) - 1];
      if (!r) throw new Error(`No recent picks for ${m.name}. Ask the court for a recommendation first.`);
      if ("accessoryId" in r) return callTool("add_accessory_to_cart", { member: m.id, accessory: r.accessoryId });
      if (r.productId) return callTool("add_product_to_cart", { member: m.id, product: r.productId, variant: r.variant, addedBy: m.id });
      return callTool("add_phone_to_cart", { member: m.id, phone: r.phoneId, storageGB: r.storageGB, addedBy: m.id });
    }
  },
  recommend_accessories: {
    description: "Accessories that fit someone's phone (the one in the cart, else their current one): a case, screen protector, charger, power bank or earbuds. Leave type empty for the essentials.",
    params: {
      member: { type: "string" },
      type: { type: "string", enum: ["case", "screen", "charger", "battery", "earbuds"], description: "optional" }
    },
    required: ["member"],
    run: (a) => {
      const m = resolveMember(a.member);
      const picks = recommendAccessories(world, m.id, { type: a.type, cart: state.cart });
      state.lastRecs[m.id] = picks.map((p) => ({ accessoryId: p.accessoryId }));
      return { forWhom: m.name, phoneBrand: phoneBrandFor(world, m.id, state.cart), picks };
    }
  },
  add_accessory_to_cart: {
    description: "Add an accessory (case, screen protector, charger, power bank, earbuds) to the cart for someone. Accepts an id or a loose name like 'rugged case'.",
    params: { member: { type: "string" }, accessory: { type: "string" } },
    required: ["member", "accessory"],
    run: (a) => {
      const m = resolveMember(a.member);
      const acc = (world.catalog.accessories ?? []).find((x) => x.id === a.accessory) ?? findAccessory(world, a.accessory);
      if (!acc) throw new Error(`No accessory matching "${a.accessory}"`);
      state.cart.push({ id: newId("c"), kind: "accessory", memberId: m.id, accessoryId: acc.id, addedBy: m.id });
      refreshTrial();
      changed();
      return { added: `${acc.name} for ${m.name}`, price: acc.price };
    }
  },
  add_phone_to_cart: {
    description: "Add a phone to the shared family cart for a member. Accepts a catalog id or a loose name like '17 pro max'.",
    params: { member: { type: "string" }, phone: { type: "string" }, storageGB: { type: "number", description: "optional storage; defaults to the smallest option" }, addedBy: { type: "string", description: "who asked" } },
    required: ["member", "phone"],
    run: (a) => {
      const m = resolveMember(a.member);
      const p = world.catalog.phones.find((x) => x.id === a.phone) ?? findPhone(world, a.phone);
      if (!p) throw new Error(`No phone matching "${a.phone}". Catalog: ${world.catalog.phones.map((x) => x.name).join(", ")}`);
      const opts = Object.keys(p.prices).map(Number).sort((x, y) => x - y);
      const gb = a.storageGB && opts.includes(a.storageGB) ? a.storageGB : opts.find((x) => x >= (a.storageGB ?? 0)) ?? opts[0];
      state.cart = state.cart.filter((i) => !(i.kind === "device" && i.memberId === m.id));
      const item = { id: newId("c"), kind: "device", memberId: m.id, phoneId: p.id, storageGB: gb, addedBy: a.addedBy };
      state.cart.push(item);
      refreshTrial();
      changed();
      return { added: `${p.name} ${gb}GB for ${m.name}`, price: p.prices[String(gb)], itemId: item.id };
    }
  },
  add_addon_to_cart: {
    description: "Add an add-on (device protection, hotspot, international pass) to the cart for a member.",
    params: { member: { type: "string" }, addon: { type: "string", description: `one of: ${world.catalog.addons.map((a) => a.id).join(", ")}` } },
    required: ["member", "addon"],
    run: (a) => {
      const m = resolveMember(a.member);
      const addon = world.catalog.addons.find((x) => x.id === a.addon || x.name.toLowerCase().includes(a.addon.toLowerCase()));
      if (!addon) throw new Error(`Unknown add-on "${a.addon}"`);
      state.cart.push({ id: newId("c"), kind: "addon", memberId: m.id, addonId: addon.id });
      refreshTrial();
      changed();
      return { added: `${addon.name} for ${m.name}`, monthly: addon.monthly };
    }
  },
  add_from_link: {
    description: "Someone pasted a store link. Match it to a catalog phone or product (with its storage/size) and add it to the cart for that member.",
    params: { url: { type: "string" }, member: { type: "string", description: "who it's for (usually the sender)" } },
    required: ["url", "member"],
    run: (a) => {
      const hit = parseLink(world, a.url);
      if (!hit) throw new Error(`Couldn't match that link to anything in the catalog. Ask what it is and what it costs, then add it with add_product_to_cart`);
      const addedBy = resolveMember(a.member).id;
      if (hit.kind === "product") return callTool("add_product_to_cart", { member: a.member, product: hit.product.id, variant: hit.variant, addedBy });
      return callTool("add_phone_to_cart", { member: a.member, phone: hit.phone.id, storageGB: hit.storageGB, addedBy });
    }
  },
  enter_evidence: {
    description: "File a photo or claim as evidence about someone's CURRENT phone (e.g. a battery-health screenshot or a cracked screen). Updates the data the rulings use. Only pass what the evidence actually shows.",
    params: {
      member: { type: "string", description: "whose phone the evidence is about" },
      batteryHealth: { type: "number", description: "battery health % if visible" },
      screenCracked: { type: "boolean", description: "true if the screen is visibly cracked" },
      finding: { type: "string", description: "one short line: what the evidence shows" }
    },
    required: ["member", "finding"],
    run: (a) => {
      const m = resolveMember(a.member);
      if (typeof a.batteryHealth === "number" && a.batteryHealth > 0 && a.batteryHealth <= 100) m.device.batteryHealth = Math.round(a.batteryHealth);
      if (a.screenCracked) m.device.screenCracked = true;
      const img = state.pendingImage;
      state.pendingImage = void 0;
      state.exhibits.push({ id: newId("x"), memberId: m.id, finding: a.finding, image: img?.dataUrl, private: img?.private ?? false, at: Date.now() });
      refreshTrial();
      changed();
      const ruling = state.trial?.rulings.find((r) => r.memberId === m.id);
      return {
        exhibit: `Exhibit ${String.fromCharCode(64 + state.exhibits.length)}`,
        device: m.device,
        updatedRuling: ruling ? { stamp: ruling.stamp, reasons: ruling.reasons, nowCost: ruling.nowCost } : "no trial yet; it will count when the cart goes on trial"
      };
    }
  },
  set_budget: {
    description: "Set the FAMILY's phone budget: the money set aside for phones over the whole plan (now and later, can span years), e.g. 'our budget is $3000'. A personal limit ('under $600 for me') goes to recommend_phones instead.",
    params: { amount: { type: "number", description: "USD; 0 clears it" } },
    required: ["amount"],
    run: (a) => {
      state.budget = a.amount > 0 ? Math.round(a.amount) : void 0;
      refreshTrial();
      changed();
      const t = state.trial;
      return { budget: state.budget ?? "none", spent: spent(), planned: t?.planned, left: t?.planned !== void 0 && t.budget !== void 0 ? t.budget - t.planned : remainingBudget(), overBudget: t?.overBudget ?? false };
    }
  },
  add_protection: {
    description: "Add Device Protection for someone's new phone (use when the court advised it, or they ask).",
    params: { member: { type: "string" } },
    required: ["member"],
    run: (a) => {
      const m = resolveMember(a.member);
      if (state.cart.some((i) => i.kind === "addon" && i.addonId === "protection-360" && i.memberId === m.id)) return { added: `Device Protection for ${m.name} (already in the cart)` };
      return callTool("add_addon_to_cart", { member: m.id, addon: "protection-360" });
    }
  },
  remove_from_cart: {
    description: "Remove items from the family cart: someone's phone and/or add-ons. Give the member, or a phone name, or an itemId.",
    params: {
      member: { type: "string", description: "whose items (optional)" },
      phone: { type: "string", description: "loose phone name to match (optional)" },
      itemId: { type: "string", description: "exact cart item id (optional)" },
      addonsToo: { type: "boolean", description: "also remove that member's add-ons (default false)" }
    },
    run: (a) => {
      if (!a.member && !a.phone && !a.itemId) throw new Error("Say whose item or which phone to remove (or clear the whole cart)");
      const hits = findCartItems(a);
      if (!hits.length) throw new Error("Nothing in the cart matches that");
      const removed = hits.map(cartItemLabel);
      state.cart = state.cart.filter((i) => !hits.includes(i));
      if (!state.cart.length) state.trial = void 0;
      refreshTrial();
      changed();
      return { removed, left: state.cart.length };
    }
  },
  clear_cart: {
    description: "Empty the whole family cart to start over (purchases already recorded are kept).",
    params: {},
    run: () => {
      const n = state.cart.length;
      state.cart = [];
      state.trial = void 0;
      changed();
      return { cleared: n };
    }
  },
  change_cart_item: {
    description: "Edit a phone already in the cart: different storage and/or a different phone. Identify it by member (or phone name).",
    params: {
      member: { type: "string" },
      phone: { type: "string", description: "current phone to match (optional)" },
      newPhone: { type: "string", description: "swap to this phone (optional)" },
      storageGB: { type: "number", description: "new storage size (optional)" }
    },
    run: (a) => {
      const item = findCartItems({ member: a.member, phone: a.phone }).find((i) => i.kind === "device");
      if (!item) throw new Error("No phone in the cart for that");
      const next = a.newPhone ? world.catalog.phones.find((x) => x.id === a.newPhone) ?? findPhone(world, a.newPhone) : phone(world, item.phoneId);
      if (!next) throw new Error(`No phone matching "${a.newPhone}"`);
      const opts = Object.keys(next.prices).map(Number).sort((x, y) => x - y);
      const want = a.storageGB ?? item.storageGB ?? opts[0];
      const gb = opts.includes(want) ? want : opts.find((x) => x >= want) ?? opts[opts.length - 1];
      const before = cartItemLabel(item);
      item.phoneId = next.id;
      item.storageGB = gb;
      refreshTrial();
      changed();
      return { from: before, to: `${next.name} ${gb}GB`, price: next.prices[String(gb)], storageNote: gb !== want ? `${want}GB isn't offered; used ${gb}GB` : void 0 };
    }
  },
  record_purchase: {
    description: "Someone actually bought a phone or an accessory (they said so, or sent a receipt / order confirmation). Records what they paid, takes it out of the cart, and tells the family how it compares. Only use a price that the person or the receipt actually states.",
    params: {
      member: { type: "string", description: "who it was for" },
      paid: { type: "number", description: "total paid in USD" },
      phone: { type: "string", description: "what they bought, if stated (defaults to their cart phone)" },
      accessory: { type: "string", description: "set instead of phone when they bought an accessory: its name or type (case, charger\u2026)" },
      fromReceipt: { type: "boolean", description: "true if read from a receipt / order confirmation" }
    },
    required: ["member", "paid"],
    run: (a) => {
      const m = resolveMember(a.member);
      if (!(a.paid > 0) || a.paid > 2e4) throw new Error("That price doesn't look right");
      if (a.accessory || a.itemId) return recordAccessory(m.id, a);
      const inCart = findCartItems({ member: m.id, phone: a.phone }).find((i) => i.kind === "device") ?? findCartItems({ member: m.id }).find((i) => i.kind === "device");
      const named = a.phone ? world.catalog.phones.find((x) => x.id === a.phone) ?? findPhone(world, a.phone) : void 0;
      const ph = named ?? (inCart?.phoneId ? phone(world, inCart.phoneId) : void 0);
      const gb = inCart?.storageGB ?? (ph ? Object.keys(ph.prices).map(Number).sort((x, y) => x - y)[0] : void 0);
      const ruling = inCart ? state.trial?.rulings.find((r) => r.itemId === inCart.id) : void 0;
      const purchase = {
        id: newId("p"),
        memberId: m.id,
        label: ph ? `${ph.name} ${gb}GB` : a.phone ?? "a phone",
        phoneId: ph?.id,
        storageGB: gb,
        paid: Math.round(a.paid),
        sticker: ph && gb ? ph.prices[String(gb)] : void 0,
        courtPrice: ruling ? ruling.stamp === "WAIT" ? ruling.heldCost : ruling.nowCost : void 0,
        day: state.day,
        at: Date.now(),
        source: a.fromReceipt ? "receipt" : "text"
      };
      state.purchases.push(purchase);
      if (inCart) {
        const gone = (i) => i.memberId === m.id && (i.id === inCart.id || i.kind === "addon");
        purchase.fromCart = state.cart.filter(gone);
        state.cart = state.cart.filter((i) => !gone(i));
      }
      if (!state.cart.length) state.trial = void 0;
      refreshTrial();
      changed();
      return {
        recorded: `${m.name}: ${purchase.label} for ${usd(purchase.paid)}`,
        forWhom: m.name,
        label: purchase.label,
        isPhone: !purchase.accessoryId,
        savedVsSticker: purchase.sticker ? purchase.sticker - purchase.paid : void 0,
        vsCourtPrice: purchase.courtPrice !== void 0 ? purchase.paid - purchase.courtPrice : void 0,
        spentSoFar: spent(),
        budgetLeft: remainingBudget()
      };
    }
  },
  reassign_purchase: {
    description: 'A parent says the purchase just logged was really for someone else ("this is for Maya"). Moves the most recent purchase (or purchaseId) to that member: their matching cart phone leaves the cart and anything removed by mistake goes back.',
    params: {
      member: { type: "string", description: "who it was really for" },
      purchaseId: { type: "string", description: "optional; defaults to the most recent purchase" }
    },
    required: ["member"],
    run: (a) => {
      const m = resolveMember(a.member);
      const p = a.purchaseId ? state.purchases.find((x) => x.id === a.purchaseId) : state.purchases.at(-1);
      if (!p) throw new Error("There's no purchase to move yet");
      if (p.memberId === m.id) return { recorded: `${m.name}: ${p.label}`, unchanged: true };
      const was = resolveMember(p.memberId).name;
      if (p.fromCart?.length) state.cart.push(...p.fromCart.filter((i) => !state.cart.some((c) => c.id === i.id)));
      const theirs = state.cart.filter((i) => i.memberId === m.id);
      const match = p.accessoryId ? theirs.find((i) => i.accessoryId === p.accessoryId) : theirs.find((i) => i.kind === "device" && i.phoneId === p.phoneId) ?? theirs.find((i) => i.kind === "device");
      const gone = (i) => !!match && i.memberId === m.id && (i.id === match.id || !p.accessoryId && i.kind === "addon");
      p.fromCart = state.cart.filter(gone);
      state.cart = state.cart.filter((i) => !gone(i));
      p.memberId = m.id;
      const ruling = match ? state.trial?.rulings.find((r) => r.itemId === match.id) : void 0;
      p.courtPrice = ruling ? ruling.stamp === "WAIT" ? ruling.heldCost : ruling.nowCost : void 0;
      if (!state.cart.length) state.trial = void 0;
      refreshTrial();
      changed();
      return { recorded: `${m.name}: ${p.label} for ${usd(p.paid)}`, movedFrom: was, tookFromCart: match ? cartItemLabel(match) : void 0 };
    }
  },
  view_cart: {
    description: "The current shared cart with sticker prices.",
    params: {},
    run: () => state.cart.map((i) => ({
      itemId: i.id,
      who: member(world, i.memberId).name,
      item: i.kind === "accessory" ? cartItemLabel(i) : cartLabel(world, i),
      ...i.kind === "addon" ? { yearly: cartPrice(world, i) } : { price: cartPrice(world, i) }
    }))
  },
  run_trial: {
    description: "Put the cart on trial before checkout. Returns rulings (KEEP/SWAP/WAIT/CUT) with exact numbers plus a ready-to-send verdict text. Use whenever someone wants to check out, asks 'should we buy', or asks the court to rule.",
    params: {},
    run: () => {
      state.trial = runTrial(world, state.cart, state.day, trialOpts());
      state.trialRuns++;
      changed();
      return { verdictText: formatVerdict(state.trial), trial: state.trial };
    }
  },
  leaving_nest: {
    description: "Someone is moving out or leaving for college: should they STAY on the family plan or LEAVE for a solo plan? Exact monthly numbers.",
    params: { member: { type: "string" } },
    required: ["member"],
    run: (a) => {
      state.nest = leavingNest(world, resolveMember(a.member).id);
      changed();
      return state.nest;
    }
  }
};
function callTool(name, args) {
  const t = tools[name];
  if (!t) return { error: `Unknown tool ${name}` };
  try {
    return t.run(args ?? {});
  } catch (e) {
    return { error: e.message };
  }
}
function recordAccessory(memberId, a) {
  const m = resolveMember(memberId);
  const accs = world.catalog.accessories ?? [];
  const mine = state.cart.filter((i) => i.kind === "accessory" && i.memberId === m.id);
  const type = a.accessory ? accessoryType(a.accessory) : void 0;
  const named = a.accessory ? accs.find((x) => x.id === a.accessory) ?? findAccessory(world, a.accessory) : void 0;
  const inCart = a.itemId ? state.cart.find((i) => i.id === a.itemId) : mine.find((i) => i.accessoryId === named?.id) ?? mine.find((i) => accs.find((x) => x.id === i.accessoryId)?.type === type);
  const acc = accs.find((x) => x.id === inCart?.accessoryId) ?? named;
  const ruling = inCart ? state.trial?.rulings.find((r) => r.itemId === inCart.id) : void 0;
  const purchase = {
    id: newId("p"),
    memberId: m.id,
    label: acc?.name ?? a.accessory ?? "an accessory",
    accessoryId: acc?.id,
    paid: Math.round(a.paid * 100) / 100,
    sticker: acc?.price,
    courtPrice: ruling ? ruling.stamp === "WAIT" ? ruling.heldCost : ruling.nowCost : void 0,
    day: state.day,
    at: Date.now(),
    source: a.fromReceipt ? "receipt" : "text"
  };
  state.purchases.push(purchase);
  if (inCart) {
    purchase.fromCart = [inCart];
    state.cart = state.cart.filter((i) => i.id !== inCart.id);
  }
  if (!state.cart.length) state.trial = void 0;
  refreshTrial();
  changed();
  return {
    recorded: `${m.name}: ${purchase.label} for ${usd(purchase.paid)}`,
    forWhom: m.name,
    label: purchase.label,
    isPhone: false,
    savedVsSticker: purchase.sticker ? purchase.sticker - purchase.paid : void 0,
    spentSoFar: spent(),
    budgetLeft: remainingBudget()
  };
}
function findCartItems(q) {
  if (q.itemId) return state.cart.filter((i) => i.id === q.itemId);
  const m = q.member ? resolveMember(q.member) : void 0;
  const p = q.phone ? world.catalog.phones.find((x) => x.id === q.phone) ?? findPhone(world, q.phone) : void 0;
  return state.cart.filter((i) => {
    if (m && i.memberId !== m.id) return false;
    if (p) return i.kind === "device" && i.phoneId === p.id;
    return i.kind === "device" || !!q.addonsToo || !m;
  });
}
function cartItemLabel(i) {
  const who = member(world, i.memberId).name.split(/\s+/)[0];
  if (i.kind === "device" && i.phoneId) return `${who}'s ${phone(world, i.phoneId).name} ${i.storageGB}GB`;
  if (i.kind === "accessory") return `${who}'s ${(world.catalog.accessories ?? []).find((a) => a.id === i.accessoryId)?.name ?? "accessory"}`;
  return `${who}'s ${world.catalog.addons.find((a) => a.id === i.addonId)?.name ?? "add-on"}`;
}

// src/feed.ts
var nameOf = (id) => world.household.members.find((m) => m.id === id)?.name ?? "Someone";
var first2 = (name) => name.split(/\s+/)[0];
function cartLabel2(itemId) {
  const i = state.cart.find((x) => x.id === itemId);
  if (!i) return "an item";
  return cartLabel(world, i);
}
function snapshot2() {
  return {
    cartIds: state.cart.map((i) => i.id),
    trialRuns: state.trialRuns,
    exhibits: state.exhibits.length,
    nest: state.nest,
    cartLabels: Object.fromEntries(state.cart.map((i) => [i.id, cartLabel2(i.id)])),
    purchases: state.purchases.length,
    owners: Object.fromEntries(state.purchases.map((p) => [p.id, p.memberId])),
    appeals: state.appeals?.length ?? 0
  };
}
function describeChanges(before, actorId) {
  const actor = actorId ? first2(nameOf(actorId)) : "The family";
  const lines = [];
  const moved = state.purchases.filter((p) => before.owners?.[p.id] && before.owners[p.id] !== p.memberId);
  if (moved.length) {
    return moved.map((p) => `\u{1F9FE} ${actor} confirmed the ${p.label} is ${first2(nameOf(p.memberId))}'s, not ${first2(nameOf(before.owners[p.id]))}'s.`);
  }
  const added = state.cart.filter((i) => !before.cartIds.includes(i.id));
  for (const i of added) {
    const forWhom = i.memberId === actorId ? "" : ` for ${first2(nameOf(i.memberId))}`;
    lines.push(`\u{1F4E5} ${actor} added ${cartLabel2(i.id)}${forWhom} to the family cart.`);
  }
  const bought = state.purchases.slice(before.purchases);
  for (const p of bought) {
    const save2 = p.sticker && p.sticker > p.paid ? `, ${usd(p.sticker - p.paid)} under sticker` : "";
    lines.push(`\u{1F9FE} ${first2(nameOf(p.memberId))}'s ${p.label} was bought for ${usd(p.paid)}${save2}.`);
  }
  const gone = before.cartIds.filter((id) => !state.cart.some((i) => i.id === id));
  if (gone.length && !state.cart.length && !bought.length && gone.length > 1) {
    lines.push(`\u{1F9F9} ${actor} cleared the family cart (${gone.length} items). Starting fresh.`);
  } else if (!added.length && !bought.length) {
    for (const id of gone) lines.push(`\u{1F5D1}\uFE0F ${actor} took ${before.cartLabels[id] ?? "an item"} out of the cart.`);
  }
  for (const i of state.cart) {
    const was = before.cartLabels[i.id];
    const now = cartLabel2(i.id);
    if (was && was !== now) lines.push(`\u270F\uFE0F ${actor} changed ${was} \u2192 ${now}.`);
  }
  if (state.exhibits.length > before.exhibits) {
    for (const e of state.exhibits.slice(before.exhibits)) {
      if (!e.private) lines.push(`\u{1F5C2}\uFE0F ${actor} filed evidence for ${first2(nameOf(e.memberId))}: ${e.finding}.`);
    }
  }
  if (state.trialRuns > before.trialRuns && state.trial) {
    const t = state.trial;
    const stamps = t.rulings.filter((r) => r.memberId && !r.label.includes("Protection")).map((r) => `${first2(nameOf(r.memberId))}: ${VERDICT[r.stamp]?.word ?? r.stamp}${r.stamp === "WAIT" ? ` till day ${r.holdUntilDay}` : ""}`).join(", ");
    lines.push(`\u2696\uFE0F ${actorId ? `${actor} asked the court to rule.` : "The court has ruled."} ${stamps}. Spend today ${usd(t.before)} \u2192 ${usd(t.now)}, you save ${usd(t.savings)}.${t.budget !== void 0 ? ` Phone budget: ${t.overBudget ? "over" : `${usd(t.budget - (t.planned ?? t.now))} left`} after this plan.` : ""} Case file: ${caseFileUrl()}`);
  }
  for (const a of (state.appeals ?? []).slice(before.appeals ?? 0)) {
    const who = first2(nameOf(a.memberId));
    lines.push(
      a.outcome === "OVERRULED" || a.outcome === "REINSTATED" ? `\u{1F528} ${a.summary}.` : `\u2696\uFE0F ${who} appealed: ${a.outcome}. ${a.summary}.`
    );
  }
  if (state.nest && state.nest !== before.nest) {
    const n = state.nest;
    lines.push(`\u{1F3E0} Ruling for ${first2(nameOf(n.memberId))}: ${n.stamp}${n.stamp === "STAY" ? ` on the family plan (saves ${usd(n.monthlySavings * 12)}/yr)` : " for a solo plan"}.`);
  }
  return lines;
}
async function deliver(text, exceptId, channel) {
  const others = world.household.members.filter((m) => m.id !== exceptId);
  if (channel === "photon") {
    if (!photonReady()) return 0;
    const group = state.groupSpaceId;
    if (group?.startsWith("photon:") && hasSpace(group)) {
      try {
        await sendTo(group, text);
        return others.length;
      } catch (e) {
        console.warn("[feed] group send failed, texting each person:", e.message);
      }
    }
    const sends = others.flatMap(
      (m) => m.handles.map((h) => sendToHandle(h, text).then(() => 1, (e) => (console.warn(`[feed] couldn't update ${m.name}:`, e.message), 0)))
    );
    return (await Promise.all(sends)).reduce((a, b) => a + b, 0);
  }
  await Promise.all(others.map((m) => sendTo(`sim:dm:${m.id}`, text, true)));
  return others.length;
}
async function broadcastChanges(before, actorId, sourceSpaceId) {
  const lines = describeChanges(before, actorId);
  if (!lines.length) return;
  logActivity(lines);
  const channel = sourceSpaceId.startsWith("photon:") ? "photon" : sourceSpaceId.startsWith("sim:dm:") ? "sim" : void 0;
  if (!channel) return;
  if (channel === "photon" && sourceSpaceId === state.groupSpaceId) return;
  const n = await deliver(lines.join("\n"), actorId, channel);
  console.log(`[feed] told ${n} others: ${lines[0].slice(0, 80)}`);
}

// src/appeal.ts
var APPEAL = /\b(appeal|i object|objection|reconsider|not fair|unfair)\b/i;
var OVERRULE = /\boverrul(e|ed|ing)\b/i;
var REINSTATE = /\breinstate\b|\bundo (the |that )?overrule\b/i;
var APPEAL_MS = 10 * 6e4;
var WITHDRAW = /^\s*(ok(ay)?|fine|k+|alright|nvm|never ?mind|forget it|whatever|nah|ugh+)\b[\s,.!]*(fine|then|whatever)?[\s.!]*$/i;
var nameOf2 = (id) => world.household.members.find((m) => m.id === id)?.name ?? "Someone";
var first3 = (id) => nameOf2(id).split(/\s+/)[0];
function record(a) {
  (state.appeals ??= []).push({ ...a, id: newId("ap"), day: state.day, at: Date.now() });
  if (state.appeals.length > 50) state.appeals.shift();
}
function phoneRuling(memberId) {
  return state.trial?.rulings.find((r) => r.memberId === memberId && !!r.proposed && state.cart.some((i) => i.id === r.itemId));
}
function appealPending(memberId) {
  const p = memberId ? state.pendingAppeal?.[memberId] : void 0;
  return p && p.until > Date.now() ? p.about : void 0;
}
var isArgument = (text) => {
  const ev = evidenceIn(text);
  return hasPrefs(parsePrefs(text)) || !!ev.battery || ev.cracked;
};
var evidenceIn = (text) => ({
  battery: Number(text.match(/(\d{2,3})\s*%/)?.[1]) || void 0,
  cracked: /\b(crack(ed)?|shattered|smashed)\b/i.test(text)
});
var describe = (r) => r.stamp === "WAIT" ? `WAIT till day ${r.holdUntilDay}, ${r.proposed?.label} for ${usd(r.heldCost)}` : `BUY the ${r.proposed?.label} for ${usd(r.nowCost)}`;
function appeal(text, senderId, aboutId, canManage2) {
  const who = aboutId ?? senderId;
  if (!who) return `Tell the court who you are first ("I'm Maya").`;
  if (!state.trial) return `There's no ruling to appeal yet. When the family is ready, say "court, rule".`;
  const old = phoneRuling(who);
  if (!old) return `${who === senderId ? "You don't" : `${first3(who)} doesn't`} have a phone ruling to appeal.${who === senderId && elsewhere(who, canManage2) || ` Add one to the cart, then say "court, rule".`}`;
  if (old.overruled) return `A parent already overruled this one: ${first3(who)} gets the ${old.proposed?.label}. Nothing left to appeal.`;
  const picked = state.cart.find((i) => i.id === old.itemId);
  if (old.stamp === "KEEP") return `Nothing to appeal, ${first3(who)}: the court already said BUY (${old.proposed?.label}, ${usd(old.nowCost)}).${who === senderId ? elsewhere(who, canManage2) : ""}`;
  const ev = evidenceIn(text);
  const argued = hasPrefs(parsePrefs(text)) || !!ev.battery || ev.cracked;
  const followUp = appealPending(senderId) === who && !APPEAL.test(text);
  if (!argued && followUp && WITHDRAW.test(text)) {
    delete state.pendingAppeal[senderId];
    return `\u2696\uFE0F Appeal withdrawn. The ruling stands: ${describe(old)}.`;
  }
  const reason = text.replace(APPEAL, " ").replace(/^[\s,.:;!-]*(i|because|bc|cuz|but)?\b[\s,.:;!-]*/i, "").trim();
  if (!argued && (followUp || reason.split(/\s+/).filter((w) => w.length > 1).length >= 3)) {
    if (senderId && state.pendingAppeal) delete state.pendingAppeal[senderId];
    const hints = changers(who, old.itemId, canManage2);
    record({ memberId: who, itemId: old.itemId, outcome: "DENIED", summary: `${describe(old)} stands` });
    changed();
    return [
      `\u2696\uFE0F APPEAL DENIED, ${first3(who)}. The court heard you, but that doesn't change the price or what the phone has to do.`,
      `The ruling stands: ${describe(old)}.`,
      hints.length ? `What would change it:
${hints.map((h) => `\u2022 ${h}`).join("\n")}` : ""
    ].filter(Boolean).join("\n");
  }
  if (!argued) {
    (state.pendingAppeal ??= {})[senderId ?? who] = { until: Date.now() + APPEAL_MS, about: who };
    const hints = changers(who, old.itemId, canManage2);
    return [
      `\u2696\uFE0F The court will hear your appeal, ${first3(who)}. Current ruling: ${describe(old)}.`,
      `In one text, tell me why.${hints.length ? ` What would change it:
${hints.map((h) => `\u2022 ${h}`).join("\n")}` : ""}`
    ].join("\n");
  }
  if (senderId && state.pendingAppeal) delete state.pendingAppeal[senderId];
  if (ev.battery || ev.cracked) {
    const finding = [ev.cracked && "Cracked screen", ev.battery && `Battery health ${ev.battery}%`].filter(Boolean).join(", ");
    callTool("enter_evidence", { member: who, batteryHealth: ev.battery, screenCracked: ev.cracked, finding });
  }
  state.trial = runTrial(world, state.cart, state.day, trialOpts());
  const now = state.trial.rulings.find((r) => r.itemId === old.itemId);
  const unheld = old.stamp === "WAIT" && now.stamp !== "WAIT";
  const gotTheirPick = now.proposed?.phoneId === picked.phoneId && old.proposed?.phoneId !== picked.phoneId;
  const outcome = unheld ? "GRANTED" : gotTheirPick ? now.stamp === "WAIT" ? "PARTLY GRANTED" : "GRANTED" : "DENIED";
  const lines = [];
  if (outcome === "DENIED") {
    const decisive = now.reasons.find((r) => !/^Trade in /.test(r)) ?? now.reasons[0];
    lines.push(`\u2696\uFE0F APPEAL DENIED, ${first3(who)}. ${decisive}.`, `The ruling stands: ${describe(now)}.`);
    const hints = changers(who, now.itemId, canManage2);
    if (hints.length) lines.push(`What would change it:
${hints.map((h) => `\u2022 ${h}`).join("\n")}`);
  } else {
    lines.push(`\u2696\uFE0F APPEAL ${outcome}, ${first3(who)}. The court heard you.`);
    if (gotTheirPick) {
      const smaller = picked.storageGB && now.proposed.storageGB !== picked.storageGB;
      const why = now.reasons.find((r) => /GB is (plenty|enough)|overkill/.test(r));
      lines.push(smaller ? `You keep the ${now.proposed.label.replace(/ \d+GB$/, "")}, at ${now.proposed.storageGB}GB.${why ? ` ${why}.` : ""}` : `You keep the ${now.proposed?.label}.`);
    }
    lines.push(now.stamp === "WAIT" ? `\u23F3 It still waits till day ${now.holdUntilDay} (${usd(now.heldCost)}): ${now.reasons.find((r) => /payments/.test(r)) ?? now.reasons.find((r) => /starts in/.test(r)) ?? now.reasons[0]}.` : `\u2705 BUY now: ${now.proposed?.label}, ${usd(now.nowCost)} today${old.stamp === "WAIT" ? ` (the old ruling: ${describe(old)})` : ""}.`);
  }
  record({ memberId: who, itemId: old.itemId, outcome, summary: outcome === "DENIED" ? `${describe(now)} stands` : describe(now) });
  changed();
  return lines.join("\n");
}
function elsewhere(who, canManage2) {
  const open = state.trial?.rulings.find((r) => r.memberId && r.memberId !== who && r.proposed && r.stamp !== "KEEP" && !r.overruled);
  if (!open) return "";
  const name = first3(open.memberId);
  return canManage2(who) ? ` To change ${name}'s: "court, overrule for ${name}". To see why: "why ${name}?"` : ` To see why ${name} waits: "why ${name}?"`;
}
function changers(who, itemId, canManage2) {
  const hints = whatWouldChange(world, state.cart, itemId, state.day, trialOpts());
  if (canManage2(who)) hints.push(`As a parent, you can overrule it: "court, overrule"`);
  else {
    const parents = world.household.members.filter((m) => canManage2(m.id)).map((m) => first3(m.id));
    if (parents.length) hints.push(`A parent can overrule: ${parents.join(" or ")} texts "court, overrule for ${first3(who)}"`);
  }
  return hints;
}
function overrule2(senderId, aboutId, canManage2) {
  if (!canManage2(senderId)) return `Only a parent can overrule the court. You can appeal: text "I appeal" and tell me why.`;
  if (!state.trial) return `There's no ruling to overrule yet. Say "court, rule" first.`;
  const lastAppeal = [...state.appeals ?? []].reverse().find((a) => a.outcome !== "OVERRULED" && a.outcome !== "REINSTATED");
  const notBuy = state.trial.rulings.filter((r2) => r2.proposed && r2.stamp !== "KEEP" && !r2.overruled);
  const who = aboutId && aboutId !== senderId ? aboutId : lastAppeal?.memberId ?? (notBuy.length === 1 ? notBuy[0].memberId : aboutId);
  if (!who) return `Whose ruling? Say "court, overrule for ${first3(notBuy[0]?.memberId) || "Maya"}".`;
  const r = phoneRuling(who);
  const item = r && state.cart.find((i) => i.id === r.itemId);
  if (!r || !item) return `${first3(who)} doesn't have a phone ruling to overrule.`;
  if (item.overruledBy) return `Already overruled: ${first3(who)} gets the ${r.proposed?.label}. To undo it, say "court, reinstate ${first3(who)}'s ruling".`;
  item.overruledBy = senderId;
  state.trial = runTrial(world, state.cart, state.day, trialOpts());
  const now = state.trial.rulings.find((x) => x.itemId === item.id);
  const extra = now.overruled?.extra ?? 0;
  record({ memberId: who, itemId: item.id, outcome: "OVERRULED", by: senderId, summary: `${first3(senderId)} overruled the court: ${first3(who)} gets the ${now.proposed?.label} today` });
  changed();
  return [
    `\u{1F528} Overruled. ${first3(who)} gets the ${now.proposed?.label} today: ${usd(now.nowCost)}${now.tradeIn ? " with trade-in" : ""}.`,
    extra > 0 ? `For the record, the court's plan was the ${now.overruled?.courtPlan}, ${usd(extra)} less. Changed your mind? "court, reinstate ${first3(who)}'s ruling".` : "It costs the same as the court's plan, so no harm done."
  ].join("\n");
}
function reinstate(senderId, aboutId, canManage2) {
  if (!canManage2(senderId)) return "Only a parent can change an overruled ruling.";
  const items = state.cart.filter((i) => i.overruledBy && (!aboutId || aboutId === senderId || i.memberId === aboutId));
  if (!items.length) return "Nothing is overruled right now.";
  for (const i of items) delete i.overruledBy;
  state.trial = runTrial(world, state.cart, state.day, trialOpts());
  const back = items.map((i) => state.trial.rulings.find((r) => r.itemId === i.id)).filter(Boolean);
  for (const r of back) record({ memberId: r.memberId, itemId: r.itemId, outcome: "REINSTATED", by: senderId, summary: `The court's ruling is back for ${first3(r.memberId)}: ${describe(r)}` });
  changed();
  return `\u2696\uFE0F Reinstated. ${back.map((r) => `${first3(r.memberId)}: ${describe(r)}`).join("; ")}.`;
}
var WHY = /^\s*(why\b|how come\b|explain\b)/i;
function explain(senderId, aboutId, canManage2) {
  if (!state.trial) return `The court hasn't ruled yet. When the family is ready, say "court, rule".`;
  const who = aboutId ?? senderId;
  const r = who ? state.trial.rulings.find((x) => x.memberId === who && x.proposed) : void 0;
  if (!r) {
    const phones = state.trial.rulings.filter((x) => x.proposed && x.memberId);
    const cuts = state.trial.rulings.filter((x) => x.stamp === "CUT");
    return [
      `\u2696\uFE0F ${who === senderId ? "You don't" : `${first3(who)} doesn't`} have a phone in this ruling.`,
      ...cuts.map((x) => `\u2702\uFE0F ${x.label.replace(/^Account · /, "")}: ${x.reasons[0]}`),
      phones.length ? `Ask about someone: "why ${first3(phones[0].memberId)}?"` : ""
    ].filter(Boolean).join("\n");
  }
  const verdict = r.overruled ? `OVERRULED by ${first3(r.overruled.by)}: the ${r.proposed?.label} today, ${usd(r.nowCost)}` : r.stamp === "KEEP" ? `BUY: the ${r.proposed?.label}, ${usd(r.nowCost)} today` : describe(r);
  const mine = who === senderId;
  const push = r.overruled ? "" : r.stamp === "KEEP" ? "" : mine ? canManage2(who) ? `Disagree? You're a parent: "court, overrule" buys it anyway.` : `Disagree? Text "I appeal" and tell me why.` : canManage2(senderId) ? `Disagree? "court, overrule for ${first3(who)}".` : "";
  return [
    `\u2696\uFE0F Why ${mine ? "your" : `${first3(who)}'s`} ruling is ${verdict}:`,
    ...r.reasons.map((x) => `\u2022 ${x}`),
    ...r.handMeDown ? [`\u2022 ${handMeDownText(world, r)}`] : [],
    push
  ].filter(Boolean).join("\n");
}

// src/agent.ts
var transcripts = /* @__PURE__ */ new Map();
var ADDRESSED = /\b(court|judge|cart ?court)\b/i;
var SHOPPING_INPUT = /https?:\/\//i;
var nameOf3 = (id) => world.household.members.find((m) => m.id === id)?.name ?? "Unknown";
function remember(spaceId, line) {
  const t = transcripts.get(spaceId) ?? [];
  t.push(line);
  if (t.length > 30) t.shift();
  transcripts.set(spaceId, t);
}
function shouldRespond(msg) {
  return !msg.isGroup || !!msg.addressed || ADDRESSED.test(msg.text) || SHOPPING_INPUT.test(msg.text) || !!msg.image || continuesAppeal(msg);
}
async function handle(msg) {
  const before = snapshot2();
  const reply = await respond(msg);
  later(() => broadcastChanges(before, msg.memberId, msg.spaceId), 400);
  return reply;
}
async function respond(msg) {
  if (!msg.memberId && msg.handle) {
    const intro = introducedAs(msg.text);
    const looksLikeIntro = /^(hi|hey|hello)?[\s,!]*(i'?m|im|i am|this is|it'?s)\b/i.test(msg.text.trim()) || msg.text.trim().split(/\s+/).length <= 3;
    if (intro && looksLikeIntro) {
      claim(msg.handle, intro);
      return welcome(intro);
    }
    if (shouldAsk(msg.handle, msg.isGroup)) return welcomeQuestion();
  }
  const who = nameOf3(msg.memberId);
  remember(msg.spaceId, `${who}: ${msg.text}${msg.image ? " [sent a photo]" : ""}`);
  if (!msg.isGroup && msg.memberId) {
    (state.privateNotes[msg.memberId] ??= []).push(msg.text);
  }
  if (msg.isGroup) state.groupSpaceId = msg.spaceId;
  if (msg.image) state.pendingImage = { dataUrl: `data:${msg.image.mimeType};base64,${msg.image.base64}`, private: !msg.isGroup };
  const said = parsePrefs(msg.text.replace(URLS, " "));
  const about = mentionedMember(msg.text)?.id ?? msg.memberId;
  const aboutOtherThings = !!findCategory(world, msg.text) && !/\bphones?\b/i.test(msg.text);
  if (about && hasPrefs(said) && !aboutOtherThings) state.prefs[about] = mergePrefs(state.prefs[about], said);
  const confirmed = confirmClear(msg);
  if (confirmed) {
    remember(msg.spaceId, `Cart Court: ${confirmed}`);
    return confirmed;
  }
  const linked = finishLink(msg);
  if (linked) {
    remember(msg.spaceId, `Cart Court: ${linked}`);
    return linked;
  }
  if (!shouldRespond(msg)) return null;
  const filed = fileLinks(msg);
  if (filed) {
    remember(msg.spaceId, `Cart Court: ${filed}`);
    return filed;
  }
  const reply = await reply_(msg);
  remember(msg.spaceId, `Cart Court: ${reply}`);
  return reply;
}
var URLS = /https?:\/\/\S+/gi;
function fileLinks(msg) {
  const urls = msg.text.match(URLS) ?? [];
  if (!urls.length) return null;
  const forWhom = mentionedMember(msg.text)?.id ?? msg.memberId;
  if (!forWhom) return null;
  const added = [];
  const unread = [];
  for (const url of urls) {
    const r = callTool("add_from_link", { url, member: forWhom });
    if (r.added) added.push(`${r.added} (${usd(r.price ?? 0)})`);
    else unread.push(url);
  }
  const lines = [];
  if (added.length) lines.push(`\u{1F4CE} Filed into the family cart: ${added.join(", ")}. You can close that tab. Nobody checks out until the court rules.`);
  if (unread.length) {
    const url = unread[0];
    const name = nameFromLink(url);
    const price = priceIn(msg.text.replace(URLS, " "));
    if (name && price) {
      const r = callTool("add_product_to_cart", { member: forWhom, product: name, price, url, addedBy: msg.memberId });
      if (r.added) lines.push(`\u{1F4CE} Filed into the family cart: ${r.added} (${usd(price)}, the price you gave). Nobody checks out until the court rules.`);
    } else {
      (state.pendingLink ??= {})[msg.memberId ?? forWhom] = { url, forWhom, until: Date.now() + RECEIPT_MS, name, price };
      const store = storeName(url);
      lines.push(name ? `\u{1F50E} The court can't read prices from ${store} yet. Is that the ${name}? Text what it costs (like "$90") and it goes in the cart.` : `\u{1F50E} The court can't read that ${store} link yet. What is it, and what does it cost? (like "air purifier, $90")`);
    }
  }
  return lines.join("\n");
}
var FILLER = /\b(it'?s|its|it|is|was|that'?s|this|the|a|an|about|like|around|costs?|for|price|yes|yeah|yep|y|ok|okay|one|bucks|dollars|usd)\b/gi;
function finishLink(msg) {
  const p = msg.memberId ? state.pendingLink?.[msg.memberId] : void 0;
  if (!p || !msg.memberId) return null;
  if (p.until < Date.now() || URLS.test(msg.text)) {
    URLS.lastIndex = 0;
    delete state.pendingLink[msg.memberId];
    return null;
  }
  const price = priceIn(msg.text) ?? (/^\W*\$?\s*\d[\d,]*(\.\d{1,2})?\W*$/.test(msg.text) ? Number(msg.text.replace(/[^\d.]/g, "")) : void 0);
  const said = msg.text.replace(PRICE, " ").replace(/\d[\d,.]*/g, " ").replace(FILLER, " ").replace(/[^\w\s'-]/g, " ").replace(/\s+/g, " ").trim();
  const name = said.split(" ").length <= 6 && /[a-z]{3}/i.test(said) && !/\?/.test(msg.text) ? said : void 0;
  if (price === void 0 && !(name && p.price !== void 0 && !p.name)) return null;
  const done = { ...p, price: price ?? p.price, name: name ?? p.name };
  if (!done.name) {
    state.pendingLink[msg.memberId] = done;
    return `Got it, ${usd(done.price)}. What is it? (like "air purifier")`;
  }
  delete state.pendingLink[msg.memberId];
  const r = callTool("add_product_to_cart", { member: done.forWhom, product: done.name, price: done.price, url: done.url, addedBy: msg.memberId });
  return r.added ? `\u{1F4E5} Added to the family cart: ${r.added} (${usd(done.price)}, the price you gave). Nobody checks out until the court rules.` : `Objection: ${r.error}`;
}
var STATUS = /\b(what'?s|whats|what is|show( me)?|see|view|check)\b[^?.!]{0,15}\b(in )?(the |our |my )?cart\b|\bwhere do we stand\b|\bwhere are we at\b|\b(what'?s|whats|what is) the status\b|\bstatus (update|check)\b|^\W*(court,?\s*)?(status|cart)\W*$/i;
var MONTHLY = /\b(pay|paying|cost|costs|bill|total|how much)\b[^.?!]{0,25}\b(a|per|each|every) month\b|^\W*(court,?\s*)?monthly\W*$|\bmonthly (cost|total|bill|payments?)\b/i;
var OLD_PHONE = /\b(what (happens|do i do|should i do) (to|with)|who gets|trade in|keep)\b[^.?!]{0,10}\bmy (old |current )?phone\b/i;
var CHATTER = /^[\s\p{Extended_Pictographic}\p{Emoji_Modifier}‍️!?.]*(lol|lmao|haha+|omg|bruh)?[\s\p{Extended_Pictographic}\p{Emoji_Modifier}‍️!?.]*$/iu;
var PROTECTION_ASK = /\badd (?:device |phone )?(?:protection|insurance)\b/i;
var TRIAL_INTENT = /\b(rule|ruling|verdict|trial|check ?out|in session)\b/i;
var CLEAR_CART = /\b(clear|empty|wipe|reset)\b[^.?!]{0,20}\bcart\b|\bcart\s+(clear|empty|wipe|reset)\b/i;
var CONFIRM_YES = /^\W*(yes|yep|yeah|y|confirm|confirmed|do it)\W*$/i;
var CONFIRM_MS = 2 * 6e4;
var RECEIPT_MS = 10 * 6e4;
var batteryReport = (msg) => !msg.isGroup && /\bbattery\b/i.test(msg.text) && /\b\d{2,3}\s*%/.test(msg.text) && !/\b(phone|pick|recommend)s?\b.*\?/i.test(msg.text);
var REMOVE_ITEM = /\b(remove|delete|take out|scratch)\b/i;
var CHANGE_ITEM = /\b(change|switch|swap|make)\b[^.?!]*\b(\d{3,4}\s*gb|to (the |a )?(iphone|pixel|galaxy))/i;
var BOUGHT = /\b(bought|purchased|ordered|picked up|just got|paid)\b/i;
var REASSIGN_WORDS = /\b(this|that|it)(?: one)?(?:'s|\s+is|\s+was)\s+(?:actually\s+|really\s+)?for\s+\w+/i;
var REASSIGN = { test: (t) => REASSIGN_WORDS.test(t) && !/\b(add|get|buy|want)\b/i.test(t) && priceIn(t) === void 0 };
var PRICE = /\$\s?(\d[\d,]*(?:\.\d{1,2})?)|\b(\d[\d,]{2,}(?:\.\d{1,2})?)\s*(?:dollars|bucks|usd)\b/i;
var priceIn = (text) => {
  const m = text.match(PRICE);
  return m ? Number((m[1] ?? m[2]).replace(/,/g, "")) : void 0;
};
var llmStatus = {};
async function reply_(msg) {
  if (batteryReport(msg)) return rulesReply(msg);
  if (courtroom(msg)) return rulesReply(msg);
  if (STATUS.test(msg.text) && !URLS.test(msg.text) && !msg.image) return formatStatus(msg.memberId);
  URLS.lastIndex = 0;
  if (MONTHLY.test(msg.text) && !URLS.test(msg.text) && !msg.image && !accessoryType(msg.text)) return formatMonthly();
  if (OLD_PHONE.test(msg.text) && !msg.image) return formatOldPhone(msg.memberId);
  URLS.lastIndex = 0;
  const cartEdit = CLEAR_CART.test(msg.text) || REASSIGN.test(msg.text) && state.purchases.length > 0 && !!mentionedMember(msg.text) || REMOVE_ITEM.test(msg.text) || CHANGE_ITEM.test(msg.text) || BOUGHT.test(msg.text) && priceIn(msg.text) !== void 0;
  if ((TRIAL_INTENT.test(msg.text) || familyBudget(msg.text) !== void 0 || PROTECTION_ASK.test(msg.text) || cartEdit) && !msg.image) return rulesReply(msg);
  if (!process.env.GEMINI_API_KEY) return rulesReply(msg);
  const applied = [];
  try {
    return await llmReply(msg, applied);
  } catch (err) {
    console.error("[llm] falling back:", err.message.slice(0, 160));
    const text = String(err.message ?? err);
    Object.assign(llmStatus, { at: Date.now(), ok: false, model: "rules", billing: /"code":\s*402|prepayment credits|billing/i.test(text), error: text.slice(0, 160) });
    return summarizeRuns(applied) ?? rulesReply(msg);
  }
}
var reasons = (why, remembered) => why.slice(0, Math.max(1, Math.min(2, remembered ? remembered.split(/, | and /).length : 1))).join("; ");
function summarizeRuns(runs) {
  const lines = runs.filter((r) => !r.result?.error).map(({ name, result: r }) => {
    switch (name) {
      case "enter_evidence": {
        const u = r.updatedRuling;
        return `\u{1F5C2}\uFE0F ${r.exhibit} entered.` + (typeof u === "string" ? " It will count when the cart goes on trial." : ` Updated ruling: ${u.stamp}. ${u.reasons[0]}.`);
      }
      case "add_phone_to_cart":
      case "add_product_to_cart":
      case "add_from_link":
      case "add_addon_to_cart":
        return `\u{1F4E5} Added: ${r.added}.`;
      case "recommend_products":
        return `The court's ${r.category} picks:
` + r.picks.map((x, i) => `${i + 1}. ${x.name}, ${usd(x.price)}: ${x.why.slice(0, 2).join("; ")}`).join("\n");
      case "report_owned_item":
        return `\u{1F5C2}\uFE0F Noted: ${r.owned.name}${r.owned.broken ? " (broken)" : ""}.` + (typeof r.updatedRuling === "string" ? "" : ` Updated ruling: ${r.updatedRuling.stamp}.`);
      case "run_trial":
        return r.verdictText;
      case "leaving_nest":
        return `\u{1F3E0} ${r.stamp}: ${r.reasons.join(". ")}.`;
      case "recommend_phones":
        return `${r.remembered ? `Got it: ${r.remembered}. ` : ""}The court's picks:
` + r.picks.map((x, i) => `${i + 1}. ${x.name} ${x.storageGB}GB, ${usd(x.price)}: ${reasons(x.why, r.remembered)}`).join("\n");
      case "add_recommended":
        return `\u{1F4E5} Added: ${r.added}.`;
      default:
        return "";
    }
  }).filter(Boolean);
  return lines.length ? lines.join("\n") : null;
}
var ai;
var models = () => (process.env.GEMINI_MODELS || process.env.GEMINI_MODEL || "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash").split(",").map((m) => m.trim()).filter(Boolean);
var coolingUntil = /* @__PURE__ */ new Map();
var CALL_TIMEOUT_MS = 15e3;
var REPLY_BUDGET_MS = 3e4;
async function generateWithFallback(req, deadline) {
  let lastErr;
  for (const model of models()) {
    if ((coolingUntil.get(model) ?? 0) > Date.now()) continue;
    const timeLeft = deadline - Date.now();
    if (timeLeft < 2e3) break;
    try {
      const abortSignal = AbortSignal.timeout(Math.min(CALL_TIMEOUT_MS, timeLeft));
      const res = await ai.models.generateContent({ ...req, model, config: { ...req.config, abortSignal } });
      Object.assign(llmStatus, { at: Date.now(), ok: true, model, billing: false, error: void 0 });
      return res;
    } catch (err) {
      const text = String(err.message ?? err);
      const slow = err.name === "TimeoutError" || err.name === "AbortError" || /abort|timed? ?out/i.test(text);
      if (/"code":\s*402|prepayment credits|billing/i.test(text)) {
        for (const m of models()) coolingUntil.set(m, Date.now() + 5 * 6e4);
        console.warn("[llm] Gemini billing: prepaid credits are empty for this key's project (ai.studio/projects). Using rules mode.");
        throw err;
      } else if (slow) {
        coolingUntil.set(model, Date.now() + 3e4);
        console.warn(`[llm] ${model} too slow; trying next model`);
      } else if (/429|RESOURCE_EXHAUSTED/.test(text)) {
        const daily = /PerDay/.test(text);
        const retry = Number(text.match(/retry in ([\d.]+)s/i)?.[1] ?? 60);
        coolingUntil.set(model, Date.now() + (daily ? Math.max(retry, 3600) : retry) * 1e3);
        console.warn(`[llm] ${model} rate-limited (${daily ? "daily" : "per-minute"}); trying next model`);
      } else throw err;
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("No Gemini model available in time");
}
function systemPrompt(msg) {
  const notes = msg.isGroup ? Object.entries(state.privateNotes).map(([id, n]) => `- ${nameOf3(id)} told you privately: ${n.slice(-5).join(" | ")}`).join("\n") : (state.privateNotes[msg.memberId ?? ""] ?? []).slice(-5).map((n) => `- ${n}`).join("\n");
  return `You are Cart Court, an honest shopping assistant living in a household's group chat (iMessage/SMS). You handle anything a family buys: phones, laptops, TVs, headphones, game consoles, appliances, furniture, mattresses, shoes, clothes, and things the store doesn't carry.
You turn the mess of links, screenshots and arguments into ONE shared cart, put the cart on trial before checkout, and often rule WAIT, because buying at the right moment is the point.

Voice: a witty but kind judge. Short texts (max ~6 lines; this is a phone). One light courtroom joke at most. No sales pressure, ever.
Plain text only: no markdown, no asterisks or bold (iMessage shows them literally). Emoji are fine.

Hard rules:
- NEVER invent prices, dates, savings, battery numbers or promos. Get every number from a tool.
- When someone wants to buy or check out, or asks you to rule, call run_trial and send its verdictText (you may add one short line before it).
- If someone wants a phone, use recommend_phones first unless they named a specific model, then add_phone_to_cart.
- Anything else (a laptop, TV, vacuum, chair, jacket\u2026): recommend_products for the category unless they named a specific product, then add_product_to_cart. If the store doesn't carry it, add it as a custom item with the price THEY gave; if they gave no price, ask for it.
- When someone says something about a thing they already own ("the vacuum died", "our TV is fine"), call report_owned_item. Broken means buy now; a working one that's still young can wait.
- Personalize: whenever someone says what they care about (battery life, a bigger or smaller screen, camera, gaming, simplicity, a price limit, a brand), call recommend_phones with those wants/brand/budget. Lead with the reason that matches what they asked for (e.g. "33h battery, among the longest here"). Preferences are remembered, so later picks keep them in mind. "Add the first one" = add_recommended with pick 1.
- If someone is moving out or leaving for college, call leaving_nest.
- Talk in plain verdicts: BUY, WAIT (and until when), SKIP. Always say how much they save.
- Accessories: for cases, screen protectors, chargers, power banks or earbuds, call recommend_accessories (it matches their phone's brand), then add_accessory_to_cart. When recommending a phone, you may suggest one matching accessory.
- Editing: "remove my phone" -> remove_from_cart; "change mine to 256GB" / "switch to the Pixel 10" -> change_cart_item; clearing the WHOLE cart: never call clear_cart yourself, tell them to text "cart clear" (parents only, confirmed with YES). Only parents may remove/change other people's items, set the family budget, or reassign a purchase; the tools refuse otherwise, so explain kindly.
- Purchases: when someone says they bought/ordered a phone, or sends a receipt or order confirmation, call record_purchase with the total they actually paid (read it from the receipt; never guess). If the total isn't stated or readable, ask for it. Kids can log their own purchases; logging one as someone else's needs a receipt photo (the tool refuses otherwise).
- "Our budget is $X" (the family's spend for now) -> set_budget. A personal limit ("under $600 for me") -> recommend_phones budget.
- When recommending, mention protection advice for the top pick (from the tool: worth it / optional / skip) and any upcoming price drop. If they want it, add_protection.
- When someone sends a photo of a phone (a cracked screen, a battery-health screenshot), call enter_evidence with ONLY what the photo actually shows, then say in one line how it changes their ruling. Call it "Exhibit A" (B, C\u2026).
- When someone pastes a store link (any product), call add_from_link.
- Private context: people can text you 1:1 ("approach the bench"). Use what they told you to shape rulings, but NEVER reveal, quote or hint that someone told you something privately.
- Stay a SHOPPING assistant: no tech support, no billing disputes.
- The case file (live cart page) is at ${caseFileUrl()}.

Context: demo day ${state.day}. Household: ${world.household.name}. Members: ${world.household.members.map((m) => `${m.name} (${m.role}, ${m.device.model})`).join(", ")}.
Already owned: ${(world.household.owned ?? []).map((o) => `${o.name}${o.memberId ? ` (${nameOf3(o.memberId)})` : ""}, ${o.ageMonths} mo${o.broken ? ", broken" : ""}`).join("; ") || "nothing on file"}.
This conversation is ${msg.isGroup ? "the GROUP chat" : `a PRIVATE 1:1 with ${nameOf3(msg.memberId)}`}. The current speaker is ${nameOf3(msg.memberId)}.
${notes ? `Private notes (never reveal):
${notes}` : ""}`;
}
async function llmReply(msg, applied = []) {
  ai ??= new GoogleGenAI2({ apiKey: process.env.GEMINI_API_KEY });
  const recent = (transcripts.get(msg.spaceId) ?? []).join("\n");
  const parts = [{ text: `Recent chat:
${recent}

Reply to ${nameOf3(msg.memberId)}'s latest message.` }];
  if (msg.image) parts.push({ inlineData: { mimeType: msg.image.mimeType, data: msg.image.base64 } });
  const contents = [{ role: "user", parts }];
  const functionDeclarations = Object.entries(tools).map(([name, t]) => ({
    name,
    description: t.description,
    parametersJsonSchema: { type: "object", properties: t.params, required: t.required ?? [] }
  }));
  const deadline = Date.now() + REPLY_BUDGET_MS;
  for (let step = 0; step < 6; step++) {
    const res = await generateWithFallback({
      contents,
      config: { systemInstruction: systemPrompt(msg), tools: [{ functionDeclarations }] }
    }, deadline);
    const calls = res.functionCalls ?? [];
    if (!calls.length) return res.text?.trim() || "The court is thinking. Ask me again?";
    contents.push(res.candidates?.[0]?.content ?? { role: "model", parts: calls.map((c) => ({ functionCall: c })) });
    contents.push({
      role: "user",
      parts: calls.map((c) => {
        const denied = c.name === "clear_cart" ? canManage(msg.memberId) ? `To clear the whole cart, text "cart clear" and confirm with YES.` : ONLY_PARENTS("clear the family cart") : guard(msg.memberId, c.name, c.args ?? {}, { image: !!msg.image });
        const result = denied ? { error: denied } : callTool(c.name, c.args ?? {});
        applied.push({ name: c.name, result });
        return { functionResponse: { id: c.id, name: c.name, response: { result } } };
      })
    });
  }
  return state.trial ? formatVerdict(state.trial) : "Order in the court. Let's try that again.";
}
function mentionedMember(text) {
  const t = text.toLowerCase();
  const word = (w) => new RegExp(`\\b${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t);
  return world.household.members.find((m) => word(m.name) || word(m.name.split(/\s+/)[0])) ?? (/\b(dad|my dad)\b/.test(t) ? world.household.members.find((m) => m.id === "marco") : void 0) ?? (/\bmom\b/.test(t) ? world.household.members.find((m) => m.id === "elena") : void 0) ?? (/\bgrandma\b/.test(t) ? world.household.members.find((m) => m.role === "grandparent") : void 0);
}
function courtroom(msg) {
  if (!state.trial) return false;
  if (OVERRULE.test(msg.text) || REINSTATE.test(msg.text) || APPEAL.test(msg.text)) return true;
  if (WHY.test(msg.text) && !msg.image && msg.text.trim().split(/\s+/).length <= 6 && !/\b(should|which|what|best|good|get|buy)\b/i.test(msg.text) && !accessoryType(msg.text)) {
    const rest = msg.text.replace(WHY, "").replace(/[?!.\s]+/g, " ").trim();
    if (!rest || mentionedMember(rest) || /\b(ruling|verdict|court|wait|skip|that|this|it|not|me|mine|my|phone|iphone|pixel|galaxy|pro|max|day)\b/i.test(rest)) return true;
  }
  if (!appealPending(msg.memberId)) return false;
  if (CHATTER.test(msg.text) && !msg.image) return false;
  const continues = continuesAppeal(msg);
  if (!continues && !msg.image) delete state.pendingAppeal[msg.memberId];
  return continues;
}
function continuesAppeal(msg) {
  if (!appealPending(msg.memberId) || CHATTER.test(msg.text)) return false;
  const text = msg.text.replace(/^\s*(court|judge|cart ?court)\b[\s,:]*/i, "");
  const question = /\?\s*$/.test(text) || /^\s*(what|which|how|can|could|should|is|are|do|does|when|where|who)\b/i.test(text);
  const command = TRIAL_INTENT.test(text) || STATUS.test(text) || MONTHLY.test(text) || REMOVE_ITEM.test(text) || CLEAR_CART.test(text);
  const continues = (isArgument(text) || !question && !command) && !URLS.test(text) && !BOUGHT.test(text) && !accessoryType(text);
  URLS.lastIndex = 0;
  return continues;
}
function rulesReply(msg) {
  const text = msg.text;
  const target = mentionedMember(text)?.id ?? msg.memberId ?? "marco";
  if (courtroom(msg)) {
    const about = mentionedMember(text)?.id;
    if (REINSTATE.test(text)) return reinstate(msg.memberId, about, canManage);
    if (OVERRULE.test(text)) return overrule2(msg.memberId, about, canManage);
    if (WHY.test(text) && !APPEAL.test(text)) return explain(msg.memberId, about, canManage);
    return appeal(text, msg.memberId, about ?? appealPending(msg.memberId), canManage);
  }
  const batt = text.match(/(\d{2,3})\s*%/);
  const cracked = /\b(crack(ed)?|shattered|smashed)\b/i.test(text);
  const receiptFollowUp = !!msg.image && (state.pendingReceipt?.[msg.memberId ?? ""]?.until ?? 0) > Date.now();
  if (!BOUGHT.test(text) && !receiptFollowUp && (msg.image || ADDRESSED.test(text) && (cracked || /battery/i.test(text)) && (cracked || batt) || batteryReport(msg))) {
    if (!batt && !cracked) return `\u{1F5C2}\uFE0F Exhibit received. Tell the court what it shows, like "cracked screen" or "battery health 76%".`;
    const finding = [cracked && "Cracked screen", batt && `Battery health ${batt[1]}%`].filter(Boolean).join(", ");
    const r = callTool("enter_evidence", { member: target, batteryHealth: batt ? Number(batt[1]) : void 0, screenCracked: cracked, finding });
    const u = r.updatedRuling;
    return `\u{1F5C2}\uFE0F ${r.exhibit} entered for ${nameOf3(target)}: ${finding}.` + (typeof u === "string" ? "" : ` Updated ruling: ${u.stamp}. ${u.reasons[1] ?? u.reasons[0]}.`);
  }
  if (!msg.isGroup && cracked && !BOUGHT.test(text)) {
    return `\u{1F4F8} The court needs to see it. Send a photo of the screen with "cracked screen" as the caption, and it goes into evidence.`;
  }
  const ownedCat = findCategory(world, text);
  const broke = /\b(died|dead|broke|broken|stopped working|doesn'?t work|won'?t turn on)\b/i.test(text);
  const fine = /\b(still works|works fine|works great|is fine)\b/i.test(text);
  if (ownedCat && (broke || fine) && !/\b(add|get|buy)\b/i.test(text)) {
    const mine = /\b(my|mine)\b/i.test(text);
    const r = callTool("report_owned_item", { member: mine ? target : void 0, category: ownedCat, broken: broke });
    if (r.error) return `Objection: ${r.error}`;
    const u = r.updatedRuling;
    return `\u{1F5C2}\uFE0F Noted for the record: the ${r.owned.name} ${broke ? "is broken. Replacing it can't wait" : "still works. No rush"}.` + (u && typeof u !== "string" ? ` Updated ruling: ${u.stamp}. ${u.reasons[0]}.` : "");
  }
  if (/\b(trial|verdict|rule|checkout|check out|session)\b/i.test(text)) {
    return callTool("run_trial", {}).verdictText;
  }
  if (/\b(moving out|move out|college|leaving)\b/i.test(text)) {
    const n = callTool("leaving_nest", { member: target });
    return `\u{1F3E0} ${n.stamp}: ${n.reasons.join(". ")}.`;
  }
  const add = text.match(/\b(?:add|get|buy)\s+(?:the\s+|a\s+|an\s+)?(.+?)\s+for\s+(\w+)(?:\s+(\d+)\s*gb)?\b/i);
  if (add) {
    const forWhom = /^(me|myself|mine|us)$/i.test(add[2]) ? msg.memberId ?? target : add[2];
    const what = add[1].replace(/\$\s*\d[\d,.]*/g, "").replace(/\s+/g, " ").trim();
    const phoneHit = bestMatch(world.catalog.phones, what);
    const productHit = bestMatch(world.catalog.products ?? [], what);
    const stated2 = (add[1].match(/\$\s*(\d[\d,]*(?:\.\d+)?)/) ?? text.match(/\$\s*(\d[\d,]*(?:\.\d+)?)/))?.[1];
    if (!phoneHit || productHit && productHit.score > phoneHit.score || !productHit && stated2) {
      const qty = what.match(/^(\d+)\s+(?:x\s+)?/i);
      const r2 = callTool("add_product_to_cart", {
        member: forWhom,
        product: qty ? what.slice(qty[0].length) : what,
        quantity: qty ? Number(qty[1]) : void 0,
        price: stated2 ? Number(stated2.replace(/,/g, "")) : void 0,
        addedBy: msg.memberId
      });
      return r2.error ? `Objection: ${r2.error}` : `\u{1F4E5} Added to the family cart: ${r2.added}. Nobody checks out until the court rules.`;
    }
    const gb = add[3] ?? add[1].match(/(\d{3,4})\s*(gb)?\b/i)?.[1];
    const phone2 = add[1].replace(/\b\d{3,4}\s*(gb)?\b/i, "").trim();
    const r = callTool("add_phone_to_cart", { member: forWhom, phone: phone2, storageGB: gb ? Number(gb) : void 0, addedBy: msg.memberId });
    return "error" in r ? `Objection: ${r.error}` : `\u{1F4E5} Added to the family cart: ${r.added}. Nobody checks out until the court rules.`;
  }
  if (CLEAR_CART.test(text)) {
    if (!canManage(msg.memberId)) return `Objection: ${ONLY_PARENTS("clear the family cart")} You can take out your own things, like "remove my phone".`;
    if (!state.cart.length) return "The family cart is already empty.";
    (state.pendingClear ??= {})[msg.memberId] = Date.now() + CONFIRM_MS;
    const n = state.cart.length;
    return `\u26A0\uFE0F This empties the whole family cart (${n} item${n === 1 ? "" : "s"}). Purchases already recorded stay. Reply YES in the next 2 minutes to clear it.`;
  }
  const forWho = REASSIGN.test(text) && state.purchases.length ? mentionedMember(text) : void 0;
  if (forWho) {
    const denied = guard(msg.memberId, "reassign_purchase", {});
    if (denied) return `Objection: ${denied}`;
    const r = callTool("reassign_purchase", { member: forWho.id });
    if (r.error) return `Objection: ${r.error}`;
    if (r.unchanged) return `\u{1F9FE} Already logged for ${forWho.name}: ${r.recorded.split(": ").slice(1).join(": ")}.`;
    return `\u{1F9FE} Fixed: that purchase is ${forWho.name}'s, not ${r.movedFrom.split(/\s+/)[0]}'s (${r.recorded.split(": ").slice(1).join(": ")}).${r.tookFromCart ? ` Took ${r.tookFromCart} out of the cart.` : ""}`;
  }
  const pending2 = msg.memberId ? state.pendingReceipt?.[msg.memberId] : void 0;
  const live = pending2 && pending2.until > Date.now() ? pending2 : void 0;
  const stated = priceIn(text);
  const afterPhoto = live?.seen && stated !== void 0 ? live : void 0;
  const photoFor = live && !live.seen && msg.image && stated === void 0 ? live : void 0;
  const paid = stated ?? photoFor?.paid;
  if ((BOUGHT.test(text) || afterPhoto || photoFor) && paid !== void 0) {
    const hasReceipt = !!msg.image || !!afterPhoto;
    const accBought = photoFor ? photoFor.accessory : /\bin case\b/i.test(text) ? void 0 : accessoryType(text);
    const named = accBought ? void 0 : photoFor ? world.catalog.phones.find((p) => p.id === photoFor.phoneId) : findPhone(world, text);
    const mentioned = photoFor?.owner ?? mentionedMember(text)?.id ?? afterPhoto?.owner;
    const self = !mentioned && /\b(for me|my|mine|myself|i got me)\b/i.test(text);
    const holders = named ? state.cart.filter((i) => i.kind === "device" && i.phoneId === named.id).map((i) => i.memberId) : [];
    const owner = mentioned ?? (self ? msg.memberId : void 0) ?? (holders.includes(msg.memberId ?? "") ? msg.memberId : holders[0]) ?? target;
    const matched = !mentioned && !self && owner !== msg.memberId && holders.includes(owner);
    if (owner !== msg.memberId && !canManage(msg.memberId) && !hasReceipt && msg.memberId) {
      (state.pendingReceipt ??= {})[msg.memberId] = { until: Date.now() + RECEIPT_MS, paid, phoneId: named?.id, accessory: accBought, owner };
      const them = nameOf3(owner).split(/\s+/)[0];
      return `\u{1F9FE} To log this as ${them}'s, send a photo of the receipt or order confirmation (or ${them} or a parent can text it). If it's yours, say "bought it for me for ${usd(paid)}".`;
    }
    if (msg.memberId && state.pendingReceipt) delete state.pendingReceipt[msg.memberId];
    const r = callTool("record_purchase", { member: owner, paid, phone: named?.id, accessory: accBought ? findAccessory(world, accBought)?.id ?? accBought : void 0, fromReceipt: hasReceipt });
    if (r.error) return `Objection: ${r.error}`;
    const first4 = (r.forWhom ?? "").split(/\s+/)[0];
    const lines = [r.isPhone ? `\u{1F9FE} Confirmed: this is ${first4}'s new phone, ${r.label} for ${usd(paid)}.${matched ? ` (It matched the one in ${first4}'s cart.)` : ""}` : `\u{1F9FE} Recorded for ${first4}: ${r.label}, ${usd(paid)}.`];
    if (r.savedVsSticker && r.savedVsSticker > 0) lines.push(`That's ${usd(r.savedVsSticker)} under sticker.`);
    if (r.vsCourtPrice !== void 0) {
      lines.push(r.vsCourtPrice <= 0 ? `Even better than the court's price. \u{1F44F}` : `The court's price was ${usd(paid - r.vsCourtPrice)} (with trade-in and promos), ${usd(r.vsCourtPrice)} less.`);
    }
    if (r.budgetLeft !== void 0) lines.push(`\u{1F4B0} Phone budget left: ${usd(r.budgetLeft)}.`);
    if (r.isPhone) lines.push(`
Not ${first4}'s? A parent can text "this is for <name>".`);
    return lines.join(" ");
  }
  if (BOUGHT.test(text) && msg.image && msg.memberId) {
    (state.pendingReceipt ??= {})[msg.memberId] = { until: Date.now() + RECEIPT_MS, seen: true, owner: mentionedMember(text)?.id };
    return '\u{1F9FE} Got the receipt. What was the total? (e.g. "paid $899")';
  }
  if (CHANGE_ITEM.test(text)) {
    const gb = Number(text.match(/(\d{3,4})\s*gb/i)?.[1]) || void 0;
    const after = text.split(/\bto\b/i).slice(1).join(" to ");
    const newPhone = after ? findPhone(world, after)?.id : void 0;
    const denied = guard(msg.memberId, "change_cart_item", { member: target });
    if (denied) return `Objection: ${denied}`;
    const r = callTool("change_cart_item", { member: target, newPhone, storageGB: gb });
    return r.error ? `Objection: ${r.error}` : `\u270F\uFE0F Changed ${r.from} \u2192 ${r.to} (${usd(r.price ?? 0)}).${r.storageNote ? ` ${r.storageNote}.` : ""}`;
  }
  if (REMOVE_ITEM.test(text)) {
    const protection = /\b(protection|insurance)\b/i.test(text);
    const accType2 = accessoryType(text);
    const itemId = protection ? state.cart.find((i) => i.kind === "addon" && i.memberId === target && i.addonId === "protection-360")?.id : accType2 ? state.cart.find((i) => i.kind === "accessory" && i.memberId === target && world.catalog.accessories?.find((a) => a.id === i.accessoryId)?.type === accType2)?.id : void 0;
    const named = protection || accType2 ? void 0 : findPhone(world, text);
    const args = itemId ? { itemId } : { member: named ? void 0 : target, phone: named?.id };
    const denied = guard(msg.memberId, "remove_from_cart", args);
    if (denied) return `Objection: ${denied}`;
    const r = callTool("remove_from_cart", args);
    return r.error ? `Objection: ${r.error}` : `\u{1F5D1}\uFE0F Removed ${r.removed.join(", ")} from the family cart.`;
  }
  const accType = /\bin case\b/i.test(text) ? void 0 : accessoryType(text);
  if (accType || /\baccessor(y|ies)\b/i.test(text)) {
    const named = findAccessory(world, text);
    if (/\b(add|buy)\b/i.test(text) && named && accType) {
      const r2 = callTool("add_accessory_to_cart", { member: target, accessory: named.id });
      return r2.error ? `Objection: ${r2.error}` : `\u{1F4E5} Added to the family cart: ${r2.added} (${usd(r2.price ?? 0)}).`;
    }
    const r = callTool("recommend_accessories", { member: target, type: accType });
    if (r.error) return `Objection: ${r.error}`;
    const whoFor = target === msg.memberId ? "your" : `${r.forWhom.split(/\s+/)[0]}'s`;
    const phoneWord = r.phoneBrand === "Apple" ? "iPhone" : r.phoneBrand === "any" ? "phone" : `${r.phoneBrand} phone`;
    return `\u{1F3A7} Picks for ${whoFor} ${phoneWord}:
${r.picks.map((p, i) => `${i + 1}. ${p.name}, ${usd(p.price)}: ${p.why[0]}
   ${p.shopLinks.map((l) => `${l.store}: ${l.url}`).join("\n   ")}`).join("\n")}
Say "add the first one" to put it in the family cart, or shop it yourself and text "bought the case for $35".`;
  }
  const fb = familyBudget(text);
  if (fb !== void 0) {
    const denied = guard(msg.memberId, "set_budget", {});
    if (denied) return `Objection: ${denied}`;
    const r = callTool("set_budget", { amount: fb });
    const status = r.planned === void 0 ? "I'll fit the plan to it when the court rules." : r.overBudget ? `This plan (${usd(r.planned)} now and later) is still over, even with cheaper picks.` : `This plan uses ${usd(r.planned)} (now and later), leaving ${usd(r.left ?? 0)}.`;
    return `\u{1F4B0} Family phone budget set: ${usd(fb)} for the whole plan, now and later. ${status}`;
  }
  if (PROTECTION_ASK.test(text)) {
    const r = callTool("add_protection", { member: target });
    return r.error ? `Objection: ${r.error}` : `\u{1F6E1}\uFE0F Added: ${r.added}.`;
  }
  const pick = text.match(/\badd (?:the )?(?:#|number )?(first|second|third|1st|2nd|3rd|1|2|3)\b/i);
  if (pick) {
    const n = { first: 1, "1st": 1, "1": 1, second: 2, "2nd": 2, "2": 2, third: 3, "3rd": 3, "3": 3 }[pick[1].toLowerCase()] ?? 1;
    const r = callTool("add_recommended", { member: target, pick: n });
    return r.error ? `Objection: ${r.error}` : `\u{1F4E5} Added to the family cart: ${r.added}. Nobody checks out until the court rules.`;
  }
  const category = findCategory(world, text);
  const shopping = /\b(recommend|suggest|which|what|should (i|we|she|he|they) get|need|looking for|want|best|cheap(est)?)\b/i;
  if (category && shopping.test(text) && !/\bphones?\b/i.test(text)) {
    const budget = text.replace(/,(\d{3})/g, "$1").match(/(?:under|below|less than|max|up to)\s*\$?\s*(\d{2,5})/i)?.[1];
    const r = callTool("recommend_products", {
      member: target,
      category,
      budget: budget ? Number(budget) : void 0,
      cheap: /\b(cheap(est)?|budget|affordable)\b/i.test(text),
      best: /\b(best|top|high[- ]end)\b/i.test(text)
    });
    if (r.error) return `Objection: ${r.error}`;
    const whoFor = target === msg.memberId ? "you" : r.forWhom.split(/\s+/)[0];
    const drop = (p) => p.priceDrop ? ` (drops to ${usd(p.priceDrop.price)} in ${p.priceDrop.inDays} days)` : "";
    return `The court's ${r.category} picks for ${whoFor}:
${r.picks.map((p, i) => `${i + 1}. ${p.name}, ${usd(p.price)}${drop(p)}: ${p.why.slice(0, 2).join("; ")}`).join("\n")}
Say "add the first one" to put it in the family cart.`;
  }
  const said = parsePrefs(text.replace(URLS, " "));
  const asking = /\b(recommend|suggest|which phone|what phone|should (i|we|she|he|they) get|need a (new )?phone|looking for|i want|i need|i'?d like|prefer|care about|something (with|that))\b/i;
  if (asking.test(text) || hasPrefs(said)) {
    const r = callTool("recommend_phones", { member: target });
    const whoFor = target === msg.memberId ? "you" : r.forWhom.split(/\s+/)[0];
    const heard = r.remembered ? `Got it: ${r.remembered}. ` : "";
    const drop = (p) => p.priceDrop ? ` (drops to ${usd(p.priceDrop.price)} in ${p.priceDrop.inDays} days)` : "";
    const top = r.picks[0];
    const shield = top ? `
\u{1F6E1}\uFE0F Protection for #1: ${top.protection.verdict === "ADD" ? "worth it. " : ""}${top.protection.reason}.` : "";
    const pairs = top ? recommendAccessories(world, target, { cart: [{ id: "preview", kind: "device", memberId: target, phoneId: top.phoneId }] }).slice(0, 2).map((a) => `${a.name} (${usd(a.price)})`) : [];
    const pairLine = pairs.length ? `
\u{1F3A7} Pairs well with: ${pairs.join(", ")}. Ask "what case should I get?" for more.` : "";
    return `${heard}The court's picks for ${whoFor}:
${r.picks.map((p, i) => `${i + 1}. ${p.name} ${p.storageGB}GB, ${usd(p.price)}${p.withTradeIn ? ` (${usd(p.withTradeIn.price)} with trade-in)` : ""}${drop(p)}: ${reasons(p.why, r.remembered)}`).join("\n")}${shield}${pairLine}
Say "add the first one" to put it in the family cart.`;
  }
  if (!msg.isGroup && /\b(tight|budget|afford|broke|expensive|money|bills?|don'?t tell)\b/i.test(text)) {
    return "Noted. That stays between us, and the court will keep it in mind. \u2696\uFE0F";
  }
  if (/^\W*(thanks|thank you|thx|ty|tysm)\b[\s\w,!.]{0,20}$/i.test(text)) return "\u2696\uFE0F Anytime. The court stands by.";
  if (/^\W*((ok(ay)?|k+|fine|alright)([\s,]+(fine|then|cool))?|cool|got it|sounds good|nice|bet|lol|lmao|haha+)\W*$/i.test(text)) return "\u2696\uFE0F Noted.";
  return [
    "\u2696\uFE0F The court is listening. You can:",
    "\u2022 Paste a store link to add it to the family cart",
    '\u2022 Ask "what phone should I get?" (say what matters: battery, big screen, camera, budget), or "what laptop should Maya get?"',
    '\u2022 Add anything with its price: "add a $90 air purifier for us"',
    "\u2022 Ask for a case, charger, screen protector or earbuds",
    '\u2022 Say "remove my phone", "cart clear" (parents), or "bought it for $899"',
    `\u2022 Ask "what's in the cart?" to see where everything stands`,
    '\u2022 Say "court, rule" when the family is ready to check out'
  ].join("\n");
}
var MANAGERS = /* @__PURE__ */ new Set(["parent", "partner"]);
var ONLY_PARENTS = (what) => `Only a parent can ${what}.`;
function canManage(memberId) {
  if (!memberId) return false;
  const members = world.household.members;
  if (!members.some((m) => MANAGERS.has(m.role))) return members.some((m) => m.id === memberId);
  return MANAGERS.has(members.find((m) => m.id === memberId)?.role ?? "");
}
function guard(memberId, name, args, ctx = {}) {
  if (canManage(memberId)) return null;
  if (name === "record_purchase" && args.member && args.member !== memberId && !ctx.image) {
    return "To log a purchase as someone else's, send a photo of the receipt (or that person or a parent can text it).";
  }
  if (name === "clear_cart") return ONLY_PARENTS("clear the family cart");
  if (name === "reassign_purchase") return ONLY_PARENTS("change who a purchase was for");
  if (name === "set_budget") return ONLY_PARENTS("set the family budget");
  if (name === "remove_from_cart" || name === "change_cart_item") {
    const hits = findCartItems(args);
    if (hits.some((i) => i.memberId !== memberId)) {
      return `${ONLY_PARENTS(`${name === "remove_from_cart" ? "remove" : "change"} someone else's items`)} You can edit your own.`;
    }
  }
  return null;
}
function confirmClear(msg) {
  const until = msg.memberId ? state.pendingClear?.[msg.memberId] : void 0;
  if (!until) return null;
  const no = /^\W*(no|nope|nah|cancel|stop|never ?mind|don'?t)\W*$/i.test(msg.text);
  if (!no && !CONFIRM_YES.test(msg.text)) return null;
  delete state.pendingClear[msg.memberId];
  if (no) return "\u{1F44D} Okay, the cart stays as it is.";
  if (Date.now() > until) return `That clear request timed out, so the cart is untouched. Text "cart clear" again if you still want to.`;
  if (!canManage(msg.memberId)) return `Objection: ${ONLY_PARENTS("clear the family cart")}`;
  const r = callTool("clear_cart", {});
  return `\u{1F9F9} Cart cleared (${r.cleared} item${r.cleared === 1 ? "" : "s"}). Start fresh: paste a store link or ask "court, what phone should I get?"`;
}

// src/dashboard.ts
import { Router as Router4 } from "express";
var dashboardRouter = Router4();
function preflight(saved) {
  const checks = [];
  checks.push(
    backend === "mongodb" ? { id: "db", label: "Storage", status: "ok", detail: "Saving to MongoDB" } : { id: "db", label: "Storage", status: "warn", detail: "Saving to files on this computer (fine on a laptop, lost on a host redeploy)" }
  );
  const photonOn = !!(process.env.PHOTON_PROJECT_ID && process.env.PHOTON_PROJECT_SECRET);
  checks.push(
    !photonOn ? { id: "photon", label: "iMessage", status: "warn", detail: "Photon not set up: simulator only (/sim)" } : photonStatus.state === "connected" ? { id: "photon", label: "iMessage", status: "ok", detail: `Connected${photonStatus.line ? ` \xB7 ${photonStatus.line}` : ""}` } : { id: "photon", label: "iMessage", status: photonStatus.state === "error" ? "err" : "warn", detail: `Photon ${photonStatus.state}` }
  );
  checks.push(
    !process.env.GEMINI_API_KEY ? { id: "llm", label: "AI", status: "warn", detail: "No Gemini key: rules mode (every demo line still works)" } : llmStatus.billing ? { id: "llm", label: "AI", status: "err", detail: "Gemini billing error: replies are in rules mode (check ai.studio/projects)" } : llmStatus.ok === false ? { id: "llm", label: "AI", status: "warn", detail: "Last reply fell back to rules mode (rate limit or timeout)" } : { id: "llm", label: "AI", status: "ok", detail: llmStatus.ok ? `Last reply from ${llmStatus.model}` : "Key set, no replies yet" }
  );
  const url = process.env.PUBLIC_URL ?? "";
  checks.push(
    url.startsWith("https://") && !/localhost|127\.0\.0\.1/.test(url) ? { id: "url", label: "Public link", status: "ok", detail: url.replace(/^https:\/\//, "") } : { id: "url", label: "Public link", status: "warn", detail: "Case-file links won't open on phones (run npm run tunnel or set PUBLIC_URL)" }
  );
  const people = world.household.members.filter((m) => saved.includes(m.id));
  const welcomed2 = people.filter((m) => [...m.handles, ...claimedHandles(m.id)].some(wasWelcomed)).length;
  checks.push(
    !people.length ? { id: "people", label: "People", status: "warn", detail: "Still the example family (add real numbers on Setup)" } : { id: "people", label: "People", status: welcomed2 === people.length ? "ok" : "warn", detail: `${welcomed2}/${people.length} welcomed` }
  );
  checks.push(
    state.trial ? { id: "cart", label: "Cart", status: "warn", detail: "Already ruled. Load the scene or restore a checkpoint before the next judge" } : { id: "cart", label: "Cart", status: "ok", detail: state.cart.length ? `${state.cart.length} filed, awaiting trial` : "Empty, ready for links" }
  );
  return checks;
}
dashboardRouter.get("/api/dashboard", (_req, res) => {
  const saved = savedMemberIds();
  res.json({
    preflight: preflight(saved),
    gemini: { configured: !!process.env.GEMINI_API_KEY, model: (process.env.GEMINI_MODELS ?? "").split(",")[0] || "gemini-3.5-flash-lite" },
    photon: { configured: !!(process.env.PHOTON_PROJECT_ID && process.env.PHOTON_PROJECT_SECRET), state: photonStatus.state, line: photonStatus.line ?? process.env.COURT_NUMBER ?? "" },
    publicUrl: process.env.PUBLIC_URL ?? "",
    setUp: saved.length > 0,
    budget: state.budget ?? null,
    spent: state.purchases.reduce((t, p) => t + p.paid, 0),
    planned: state.trial?.planned ?? null,
    overBudget: state.trial?.overBudget ?? false,
    // Price tracker: every phone and product in the cart, now vs the lowest price coming up (synthetic store prices).
    tracker: state.cart.filter((i) => i.kind === "device" && i.phoneId || i.kind === "product").map((i) => {
      const custom = i.custom ? { price: i.custom.price, category: i.custom.category } : void 0;
      const t = i.kind === "device" ? priceTrack(world, i.phoneId, i.storageGB ?? 128, state.day, 120) : priceTrack(world, i.productId ?? `custom:${i.id}`, i.variant ?? "std", state.day, 120, custom);
      return { who: world.household.members.find((m) => m.id === i.memberId)?.name ?? "", label: cartLabel(world, i), now: t.now, lowest: t.lowest };
    }),
    members: world.household.members.filter((m) => !saved.length || saved.includes(m.id)).map((m) => {
      const handles = [.../* @__PURE__ */ new Set([...m.handles, ...claimedHandles(m.id)])];
      const ruling = state.trial?.rulings.find((r) => r.memberId === m.id && r.proposed?.phoneId);
      return {
        id: m.id,
        name: m.name,
        role: m.role,
        phone: m.device.model,
        battery: m.device.batteryHealth,
        linked: handles.length > 0,
        welcomed: handles.some(wasWelcomed),
        ruling: ruling ? { stamp: ruling.stamp, label: ruling.proposed?.label ?? ruling.label, holdUntilDay: ruling.holdUntilDay } : void 0
      };
    })
  });
});
dashboardRouter.post("/api/dashboard/budget", (req, res) => {
  const amount = Number(req.body?.amount ?? 0);
  res.json(callTool("set_budget", { amount: Number.isFinite(amount) ? amount : 0 }));
});
dashboardRouter.post("/api/dashboard/rule", async (_req, res) => {
  if (!state.cart.length) return res.json({ ok: false, error: "The cart is empty. Nothing to rule on yet." });
  const before = snapshot2();
  callTool("run_trial", {});
  const lines = describeChanges(before, void 0);
  logActivity(lines);
  const told = await deliver(lines.join("\n"), void 0, "photon");
  res.json({ ok: true, told });
});
async function announce(before) {
  const lines = describeChanges(before, void 0);
  if (!lines.length) return 0;
  logActivity(lines);
  return deliver(lines.join("\n"), void 0, "photon");
}
dashboardRouter.post("/api/dashboard/cart/remove", async (req, res) => {
  const before = snapshot2();
  const r = callTool("remove_from_cart", { itemId: String(req.body?.itemId ?? "") });
  res.json({ ...r, told: await announce(before) });
});
dashboardRouter.post("/api/dashboard/cart/clear", async (_req, res) => {
  const before = snapshot2();
  const r = callTool("clear_cart", {});
  res.json({ ...r, told: await announce(before) });
});
dashboardRouter.post("/api/dashboard/cart/bought", async (req, res) => {
  const item = state.cart.find((i) => i.id === req.body?.itemId);
  if (!item) return res.json({ error: "That item isn't in the cart anymore." });
  const before = snapshot2();
  const r = callTool("record_purchase", item.kind === "accessory" ? { member: item.memberId, paid: Number(req.body?.paid), itemId: item.id } : { member: item.memberId, paid: Number(req.body?.paid), phone: item.phoneId });
  if (!r.error) state.purchases[state.purchases.length - 1].source = "dashboard";
  res.json({ ...r, told: await announce(before) });
});
dashboardRouter.post("/api/dashboard/purchase/undo", (req, res) => {
  const before = state.purchases.length;
  state.purchases = state.purchases.filter((p) => p.id !== req.body?.id);
  refreshTrial();
  changed();
  res.json({ removed: before - state.purchases.length });
});

// src/demo.ts
import { Router as Router5 } from "express";
var MAX_CHECKPOINTS = 10;
var demoRouter = Router5();
function seedCart() {
  callTool("add_phone_to_cart", { member: "maya", phone: "iphone-17-pro-max", storageGB: 512, addedBy: "maya" });
  callTool("add_phone_to_cart", { member: "marco", phone: "iphone-17-pro", storageGB: 256, addedBy: "marco" });
  callTool("add_phone_to_cart", { member: "elena", phone: "pixel-10-pro", storageGB: 256, addedBy: "elena" });
}
function loadPrefiledScene() {
  reset();
  forgetClaims();
  seedCart();
  state.privateNotes.elena = ["honestly money is tight this month, don't tell the kids"];
  logActivity(["\u{1F3AC} Scene loaded: three phones filed, awaiting trial"]);
}
var list = () => get("checkpoints", []);
var summary = (c) => ({
  id: c.id,
  name: c.name,
  at: c.at,
  day: c.snap.day,
  cart: c.snap.cart.length,
  ruled: !!c.snap.trial
});
demoRouter.get("/api/demo/checkpoints", (_req, res) => res.json(list().map(summary).reverse()));
demoRouter.post("/api/demo/checkpoints", (req, res) => {
  const fallback = state.trial ? `Day ${state.day}, ruled` : `Day ${state.day}, ${state.cart.length} in the cart`;
  const name = String(req.body?.name ?? "").trim().slice(0, 60) || fallback;
  const all = [...list(), { id: newId("k"), name, at: Date.now(), snap: snapshot() }].slice(-MAX_CHECKPOINTS);
  put("checkpoints", all);
  res.json({ ok: true, checkpoint: summary(all.at(-1)) });
});
demoRouter.post("/api/demo/checkpoints/:id/restore", (req, res) => {
  const c = list().find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ ok: false, error: "That checkpoint is gone." });
  restoreSnapshot(c.snap);
  logActivity([`\u23EA Restored checkpoint "${c.name}"`]);
  res.json({ ok: true });
});
demoRouter.delete("/api/demo/checkpoints/:id", (req, res) => {
  put("checkpoints", list().filter((x) => x.id !== req.params.id));
  res.json({ ok: true });
});
demoRouter.post("/api/demo/scene/prefiled", (_req, res) => {
  loadPrefiledScene();
  res.json({ ok: true });
});

// src/app.ts
var app2 = express();
app2.set("trust proxy", true);
var inflight = 0;
if (serverless) {
  app2.use(async (_req, res, next) => {
    if (inflight++ === 0) await reload().catch((err) => console.error("[db] reload failed:", err));
    const closed = new Promise((r) => res.on("close", () => r()));
    void keepAlive(
      closed.then(settle).then(() => {
        persist();
        return flush();
      }).finally(() => inflight--)
    );
    next();
  });
}
app2.post("/api/photon/webhook", express.raw({ type: "*/*", limit: "25mb" }), async (req, res) => {
  try {
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v ?? "")]));
    const r = await handleWebhook(new Uint8Array(req.body), headers);
    res.status(r.status).set(r.headers).send(Buffer.from(r.body));
  } catch (err) {
    console.error("[photon] webhook failed:", err);
    res.status(500).json({ ok: false });
  }
});
app2.use(express.json({ limit: "12mb" }));
app2.use(authRouter(isAdmin));
app2.use(setupRouter);
app2.use((req, _res, next) => {
  const host = req.headers.host ?? "";
  const tunnel = /\.(trycloudflare\.com|ngrok-free\.app|ngrok\.io|loca\.lt|run\.app|onrender\.com|fly\.dev|up\.railway\.app|herokuapp\.com|vercel\.app)$/i.test(host.split(":")[0]);
  const current = process.env.PUBLIC_URL ?? "";
  if (tunnel && (!current || current.includes("localhost"))) {
    process.env.PUBLIC_URL = `https://${host}`;
    console.log(`[url] case-file links now use ${process.env.PUBLIC_URL}`);
  }
  next();
});
app2.get("/healthz", (_req, res) => res.json({ ok: true, db: backend, photon: photonStatus.state, day: state.day, cart: state.cart.length }));
app2.get("/", (req, res) => {
  const fresh2 = savedMemberIds().length === 0;
  if (isAdmin(req)) return fresh2 ? res.redirect("/welcome") : res.sendFile(fileURLToPath5(new URL("../public/dashboard.html", import.meta.url)));
  res.redirect(fresh2 ? "/login?next=%2Fwelcome" : "/cart");
});
app2.use(dashboardRouter);
app2.use(demoRouter);
app2.use(shareRouter);
app2.use(express.static(fileURLToPath5(new URL("../public/", import.meta.url)), { extensions: ["html"] }));
app2.get("/api/events", (req, res) => {
  if (serverless) return res.status(204).end();
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  const withChat = req.query.chat === "1" && isAdmin(req);
  const send = (event, data) => res.write(`event: ${event}
data: ${JSON.stringify(data)}

`);
  send("state", publicState());
  if (withChat) state.chat.forEach((c) => send("chat", c));
  const onState = (s) => send("state", s);
  const onChat = (c) => withChat && send("chat", c);
  bus.on("state", onState);
  bus.on("chat", onChat);
  req.on("close", () => {
    bus.off("state", onState);
    bus.off("chat", onChat);
  });
});
app2.get(
  "/api/state",
  (req, res) => res.json(req.query.chat === "1" && isAdmin(req) ? { ...publicState(), chat: state.chat.map(({ image: _i, ...c }) => c) } : publicState())
);
registerChannel("sim", async () => {
});
app2.post("/api/sim/message", async (req, res) => {
  const body = req.body;
  let { text = "", dm = false, image } = body;
  const phone2 = body.memberId.startsWith("new:") ? body.memberId.slice(4) : void 0;
  const memberId = phone2 ? memberForHandle(phone2) : body.memberId;
  const spaceId = dm ? `sim:dm:${body.memberId}` : "sim:group";
  if (body.tapback) {
    const target = state.chat.find((l) => l.id === body.lineId);
    addChat({ spaceId, from: memberId ?? "unknown", text: tapbackLog(body.tapback, target?.text), private: dm });
    const asked2 = memberId ? tapbackText(body.tapback, target?.text, target?.from === "court") : void 0;
    if (!asked2) return void res.json({ ok: true, replied: false });
    text = asked2;
    image = void 0;
  } else addChat({ spaceId, from: memberId ?? "unknown", text, private: dm, image });
  const img = image?.match(/^data:(.+?);base64,(.+)$/);
  try {
    const reply = await handle({ spaceId, isGroup: !dm, memberId, handle: phone2, text, addressed: !!body.tapback, image: img ? { mimeType: img[1], base64: img[2] } : void 0 });
    if (reply) await sendTo(spaceId, reply, dm);
    res.json({ ok: true, replied: !!reply });
  } catch (err) {
    console.error(err);
    await sendTo(spaceId, "\u26A0\uFE0F The court hit an error. Check the server log.", dm);
    res.status(500).json({ ok: false, error: String(err) });
  }
});
app2.post("/api/demo/advance", async (req, res) => {
  const days = Number(req.body?.days ?? 41);
  const newDay = state.day + days;
  const due = readyHolds(state.trial, newDay);
  state.day = newDay;
  state.trial = advanceTrial(world, state.cart, state.trial, newDay, trialOpts());
  changed();
  for (const r of due) {
    const who = (world.household.members.find((m) => m.id === r.memberId)?.name ?? "").split(/\s+/)[0];
    const text = `\u23F3\u27A1\uFE0F\u2705 ${who}, it's time. Your ${r.proposed?.label} is ready at ${usd(r.heldCost)} instead of ${usd(r.originalCost)}. Waiting saved ${usd(r.savings)}. Case file: ${caseFileUrl()}`;
    logActivity([text]);
    await deliver(text, void 0, "photon");
    if (!state.groupSpaceId?.startsWith("photon:")) await sendTo(state.groupSpaceId ?? "sim:group", text);
  }
  res.json({ day: state.day, announced: due.length });
});
app2.post("/api/demo/seed", (_req, res) => {
  seedCart();
  res.json(publicState());
});
var ARGUMENT = [
  ["maya", "my phone is SO slow \u{1F62D} literally everyone at school has the 17 Pro Max"],
  ["maya", "https://store.example.com/iphone-17-pro-max?storage=512"],
  ["marco", "honestly mine's getting old too. if we're doing this I want the 17 Pro"],
  ["elena", "my Pixel dies by 2pm every single day. Pixel 10 Pro for me"],
  ["maya", "so we're ALL upgrading?? \u{1F64F}\u{1F64F}"],
  ["marco", "let's just order everything tonight"]
];
var arguing = false;
app2.post("/api/demo/argue", async (_req, res) => {
  if (arguing) return res.json({ ok: false, busy: true });
  arguing = true;
  res.json({ ok: true });
  background(playArgument(state.groupSpaceId ?? "sim:group"));
});
async function playArgument(spaceId) {
  try {
    for (const [from, text] of ARGUMENT) {
      addChat({ spaceId, from, text, private: false });
      const reply = await handle({ spaceId, isGroup: true, memberId: from, text });
      if (reply) await sendTo(spaceId, reply);
      await new Promise((r) => setTimeout(r, 1100));
    }
    seedCart();
    const sticker2 = state.cart.reduce((s, i) => s + cartPrice(world, i), 0);
    await sendTo(spaceId, `\u{1F4E5} Entered into the family cart: 17 Pro Max 512GB (Maya), 17 Pro 256GB (Marco), Pixel 10 Pro 256GB (Elena). Sticker total ${usd(sticker2)}. Nobody checks out until the court rules. Say "court, rule".`);
  } finally {
    arguing = false;
  }
}
app2.post("/api/demo/reset", (_req, res) => {
  reset();
  forgetClaims();
  res.json({ ok: true });
});

// src/vercel.ts
function handler(req, res) {
  return app2(req, res);
}
export {
  handler as default
};
