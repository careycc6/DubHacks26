import { test } from "node:test";
import assert from "node:assert/strict";
import { loadWorld } from "../src/data.ts";
import { findPhone, leavingNest, readyHolds, recommend, runTrial } from "../src/engine.ts";
import type { CartItem } from "../src/types.ts";

const world = loadWorld();
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
