import { test } from "node:test";
import assert from "node:assert/strict";
import { loadWorld } from "../src/data.ts";
import { findPhone, leavingNest, readyHolds, recommend, runTrial } from "../src/engine.ts";
import type { CartItem } from "../src/types.ts";

const world = loadWorld({ local: false }); // the example family, never your real household
const demoCart: CartItem[] = [
  { id: "1", kind: "device", memberId: "marco", phoneId: "iphone-17-pro", storageGB: 256 },
  { id: "2", kind: "device", memberId: "elena", phoneId: "pixel-10-pro", storageGB: 256 },
  { id: "3", kind: "device", memberId: "maya", phoneId: "iphone-17-pro-max", storageGB: 512 },
  { id: "4", kind: "addon", memberId: "maya", addonId: "protection-360" },
];

test("dad waits for the trade-in promo", () => {
  const r = runTrial(world, demoCart, 0).rulings.find((x) => x.memberId === "marco")!;
  assert.equal(r.stamp, "WAIT");
  assert.equal(r.holdUntilDay, 41);
  assert.equal(r.nowCost, 0);
});

test("mom upgrades now (dying battery) with launch credit + trade-in", () => {
  const r = runTrial(world, demoCart, 0).rulings.find((x) => x.memberId === "elena")!;
  assert.notEqual(r.stamp, "WAIT");
  assert.equal(r.nowCost, 1099 - 90 - 100);
});

test("teen's Pro Max 512 gets swapped down and held until payments end", () => {
  const r = runTrial(world, demoCart, 0).rulings.find((x) => x.itemId === "3")!;
  assert.equal(r.stamp, "WAIT");
  assert.equal(r.proposed?.phoneId, "iphone-17");
  assert.equal(r.proposed?.storageGB, 256);
  assert.equal(r.holdUntilDay, 120);
});

test("unused add-ons are cut and totals add up", () => {
  const t = runTrial(world, demoCart, 0);
  assert.ok(t.rulings.some((r) => r.stamp === "CUT" && r.itemId.startsWith("account:")));
  assert.equal(t.before, t.rulings.reduce((s, r) => s + r.originalCost, 0));
  assert.ok(t.now < t.before);
});

test("holds come due as the clock moves", () => {
  const t = runTrial(world, demoCart, 0);
  assert.equal(readyHolds(t, 40).length, 0);
  assert.deepEqual(readyHolds(t, 41).map((r) => r.memberId), ["marco"]);
  assert.equal(readyHolds(t, 120).length, 2);
});

test("leaving the nest: staying on the family line is cheaper", () => {
  const n = leavingNest(world, "maya");
  assert.equal(n.stamp, "STAY");
  assert.equal(n.familyLineMonthly, 20);
});

test("grandma gets a simple phone; fuzzy phone lookup works", () => {
  assert.ok(world.catalog.phones.find((p) => p.id === recommend(world, "rosa")[0].phoneId)?.simple);
  assert.equal(findPhone(world, "the new 17 pro max")?.id, "iphone-17-pro-max");
  assert.equal(findPhone(world, "pixel 10")?.id, "pixel-10");
});

test("advancing the clock locks bought items and re-judges held ones", async () => {
  const { advanceTrial } = await import("../src/engine.ts");
  const t0 = runTrial(world, demoCart, 0);
  const t41 = advanceTrial(world, demoCart, t0, 41)!;
  const mom0 = t0.rulings.find((r) => r.memberId === "elena")!;
  assert.deepEqual(t41.rulings.find((r) => r.memberId === "elena"), mom0); // promo expired, purchase locked
  assert.notEqual(t41.rulings.find((r) => r.memberId === "marco")!.stamp, "WAIT"); // promo live now
});

test("a held phone's payoff date doesn't drift as days pass", async () => {
  const { advanceTrial } = await import("../src/engine.ts");
  const t41 = advanceTrial(world, demoCart, runTrial(world, demoCart, 0), 41)!;
  assert.equal(t41.rulings.find((r) => r.itemId === "3")!.holdUntilDay, 120);
  assert.equal(advanceTrial(world, demoCart, t41, 120)!.rulings.find((r) => r.itemId === "3")!.stamp, "SWAP");
});

test("a private 'money is tight' DM trims Mom's buy-now flagship without touching Dad's WAIT", () => {
  const t = runTrial(world, demoCart, 0, { tightBudget: true });
  const mom = t.rulings.find((r) => r.memberId === "elena")!;
  assert.equal(mom.stamp, "SWAP");
  assert.equal(mom.proposed?.phoneId, "pixel-10");
  assert.ok(!mom.reasons.join(" ").toLowerCase().includes("private"));
  assert.equal(t.rulings.find((r) => r.memberId === "marco")!.stamp, "WAIT");
  assert.ok(t.now < runTrial(world, demoCart, 0).now);
});

test("held phones get a witness statement", () => {
  const dad = runTrial(world, demoCart, 0).rulings.find((r) => r.memberId === "marco")!;
  assert.match(dad.witness ?? "", /iPhone 15 Pro.*89%/);
});

test("a held ruling keeps its promised numbers until its day", async () => {
  const { advanceTrial } = await import("../src/engine.ts");
  const t0 = runTrial(world, demoCart, 0);
  const t41 = advanceTrial(world, demoCart, t0, 41)!;
  assert.deepEqual(t41.rulings.find((r) => r.itemId === "3"), t0.rulings.find((r) => r.itemId === "3"));
});

test("store links become catalog phones with the right storage", async () => {
  const { parseProductLink } = await import("../src/engine.ts");
  const a = parseProductLink(world, "https://store.example.com/iphone-17-pro-max?storage=512")!;
  assert.equal(a.phone.id, "iphone-17-pro-max");
  assert.equal(a.storageGB, 512);
  const b = parseProductLink(world, "https://shop.example.com/phones/google-pixel-10-pro-256gb")!;
  assert.equal(b.phone.id, "pixel-10-pro");
  assert.equal(b.storageGB, 256);
  assert.equal(parseProductLink(world, "https://example.com/blog/best-headphones"), undefined);
});

test("a cracked screen on a healthy phone gets a repair today, not a new phone", () => {
  const w = structuredClone(world);
  w.household.members.find((m) => m.id === "maya")!.device.screenCracked = true;
  const r = runTrial(w, demoCart, 0).rulings.find((x) => x.itemId === "3")!;
  assert.equal(r.stamp, "WAIT");
  assert.equal(r.nowCost, 129);
  assert.match(r.reasons.join(" "), /screen repair/);
});

test("reads what people care about from a message", async () => {
  const { parsePrefs } = await import("../src/engine.ts");
  assert.deepEqual(parsePrefs("I want a phone with long battery life and a bigger screen"), { battery: true, bigScreen: true });
  assert.deepEqual(parsePrefs("something small, under $600, I like Samsung"), { smallScreen: true, budget: 600, brand: "Samsung" });
  assert.deepEqual(parsePrefs("best camera for selfies"), { camera: true });
  assert.deepEqual(parsePrefs("ok sounds good"), {});
});

test("picks follow what they asked for", async () => {
  const { parsePrefs } = await import("../src/engine.ts");
  const top = (msg: string, who = "maya") => recommend(world, who, { prefs: parsePrefs(msg) });
  assert.ok(top("long battery life").slice(0, 2).every((r) => world.catalog.phones.find((p) => p.id === r.phoneId)!.batteryHours >= 32));
  assert.equal(world.catalog.phones.find((p) => p.id === top("I need a bigger screen")[0].phoneId)!.screenIn, 6.9);
  assert.ok(top("cheap phone under $500").every((r) => r.price <= 500));
  assert.ok(top("best camera, I like iPhone").every((r) => r.name.startsWith("iPhone")));
});

test("someone who asked for a great camera keeps their Pro phone", () => {
  const plain = runTrial(world, demoCart, 0).rulings.find((r) => r.itemId === "3")!;
  const withPrefs = runTrial(world, demoCart, 0, { prefs: { maya: { camera: true } } }).rulings.find((r) => r.itemId === "3")!;
  assert.equal(plain.proposed?.phoneId, "iphone-17");
  assert.equal(withPrefs.proposed?.phoneId, "iphone-17-pro-max");
});

test("family budget holds the purchases that can wait, never a failing phone", async () => {
  const { familyBudget } = await import("../src/engine.ts");
  assert.equal(familyBudget("our budget is $1,500"), 1500);
  assert.equal(familyBudget("I want something under $600"), undefined);
  const cart: CartItem[] = [
    { id: "a", kind: "device", memberId: "elena", phoneId: "pixel-10", storageGB: 256 }, // battery 71%: needs it now
    { id: "b", kind: "device", memberId: "marco", phoneId: "pixel-10", storageGB: 256 }, // healthy 89%
  ];
  const t = runTrial(world, cart, 50, { budget: 600 }); // past the promos, so nothing is waiting on a sale
  assert.equal(t.rulings.find((r) => r.itemId === "a")!.stamp !== "WAIT", true);
  assert.equal(t.rulings.find((r) => r.itemId === "b")!.stamp, "WAIT");
  assert.ok(t.now <= 600 || t.overBudget);
});

test("protection advice: worth it for a teen's $1,199 phone, skip for a $399 one", async () => {
  const { protectionAdvice } = await import("../src/engine.ts");
  const maya = world.household.members.find((m) => m.id === "maya")!;
  const marco = world.household.members.find((m) => m.id === "marco")!;
  assert.equal(protectionAdvice(maya, 1199).verdict, "ADD");
  assert.equal(protectionAdvice(marco, 399).verdict, "SKIP");
  assert.equal(protectionAdvice(marco, 899).verdict, "OPTIONAL");
});

test("price tracker finds the promo dip", async () => {
  const { priceTrack } = await import("../src/engine.ts");
  const t = priceTrack(world, "iphone-17-pro", 256, 0, 120);
  assert.equal(t.now, 1099);
  assert.deepEqual(t.lowest, { day: 41, price: 1099 - 312 });
});

test("accessories match the phone and wait with it", async () => {
  const { recommendAccessories, accessoryType, findAccessory } = await import("../src/engine.ts");
  assert.equal(accessoryType("what case should I get?"), "case");
  assert.equal(accessoryType("any good earbuds?"), "earbuds");
  assert.equal(findAccessory(world, "add the rugged case")?.id, "rugged-case");
  const cart: CartItem[] = [{ id: "p", kind: "device", memberId: "maya", phoneId: "iphone-17-pro-max", storageGB: 512 }];
  const cases = recommendAccessories(world, "maya", { type: "case", cart });
  assert.equal(cases[0].accessoryId, "rugged-case"); // teen: drop-proof first
  assert.ok(cases.every((c) => c.accessoryId !== "pixel-case" && c.accessoryId !== "galaxy-case"));
  const withCase: CartItem[] = [...cart, { id: "c", kind: "accessory", memberId: "maya", accessoryId: "clear-case-magsafe" }];
  const t = runTrial(world, withCase, 0);
  assert.equal(t.rulings.find((r) => r.itemId === "p")!.stamp, "WAIT");
  assert.equal(t.rulings.find((r) => r.itemId === "c")!.stamp, "WAIT"); // buy it with the phone
  const wrong: CartItem[] = [...cart, { id: "g", kind: "accessory", memberId: "maya", accessoryId: "galaxy-case" }];
  assert.equal(runTrial(world, wrong, 0).rulings.find((r) => r.itemId === "g")!.stamp, "CUT"); // doesn't fit an iPhone
});
