// Everything that isn't a phone: laptops, TVs, appliances, furniture, clothes, and items the store doesn't carry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadWorld } from "../src/data.ts";
import { findCategory, parseLink, recommendProducts, runTrial } from "../src/engine.ts";
import type { CartItem } from "../src/types.ts";

const world = loadWorld({ local: false });
const item = (id: string, memberId: string, rest: Partial<CartItem>): CartItem => ({ id, kind: "product", memberId, ...rest });
const rule = (cart: CartItem[], id: string, opts = {}) => runTrial(world, cart, 0, opts).rulings.find((r) => r.itemId === id)!;

test("a TV waits for Black Friday when the old one still works", () => {
  const r = rule([item("t", "marco", { productId: "samsung-qled-q70", variant: "65in" })], "t");
  assert.equal(r.stamp, "WAIT");
  assert.equal(r.holdUntilDay, 41);
  assert.equal(r.heldCost, 999 - 200); // 20% off
  assert.equal(r.nowCost, 0);
  assert.match(r.witness ?? "", /Vizio/);
  assert.equal(r.witnessOf, "the household's living-room Vizio 50in TV");
});

test("a broken vacuum is replaced now, sale or not, and never held for budget", () => {
  const cart = [item("v", "elena", { productId: "shark-stratos" })];
  const r = rule(cart, "v", { budget: 100 });
  assert.equal(r.stamp, "KEEP");
  assert.equal(r.nowCost, 399);
  assert.equal(r.urgent, true);
  assert.match(r.reasons[0], /broken/);
});

test("an old laptop is traded in and the live credit applies", () => {
  const r = rule([item("l", "marco", { productId: "macbook-air-13", variant: "256GB" })], "l");
  assert.equal(r.stamp, "KEEP");
  assert.equal(r.nowCost, 1099 - 150 - 100);
  assert.equal(r.math!.reduce((s, x) => s + x.amount, 0), r.nowCost);
});

test("a working, young item is a want: sleep on it", () => {
  const r = rule([item("h", "maya", { productId: "airpods-pro-3" })], "h");
  assert.equal(r.stamp, "WAIT"); // Black Friday is coming anyway
  const shoes = rule([item("s", "maya", { productId: "nike-pegasus-41" })], "s");
  assert.equal(shoes.stamp, "KEEP"); // nothing owned, no sale coming
  assert.equal(shoes.nowCost, 140);
});

test("custom items and quantities: the price they gave, times how many", () => {
  const r = rule([item("c", "rosa", { custom: { name: "air purifier", price: 90 }, quantity: 2 })], "c");
  assert.equal(r.stamp, "KEEP");
  assert.equal(r.originalCost, 180);
  assert.equal(r.label, "Rosa · 2 × air purifier");
  const tv = rule([item("c2", "marco", { custom: { name: "Hisense 75in TV", price: 800, category: "tv" } })], "c2");
  assert.equal(tv.stamp, "WAIT"); // category sales cover items the store doesn't list
  assert.equal(tv.heldCost, 640);
});

test("the same thing twice is struck", () => {
  const cart = [item("a", "maya", { productId: "switch-2" }), item("b", "maya", { productId: "switch-2" })];
  assert.equal(rule(cart, "b").stamp, "CUT");
  assert.notEqual(rule(cart, "a").stamp, "CUT");
});

test("money-is-tight trims a premium pick to a cheaper one rated nearly as well", () => {
  const r = rule([item("ch", "elena", { productId: "aeron-chair" })], "ch", { tightBudget: true });
  assert.equal(r.proposed?.productId, "branch-ergo-chair");
});

test("family budget holds a nice-to-have before a phone that's failing", () => {
  const cart: CartItem[] = [
    { id: "p", kind: "device", memberId: "elena", phoneId: "pixel-10-pro", storageGB: 128 },
    item("s", "maya", { productId: "nike-pegasus-41" }),
  ];
  const t = runTrial(world, cart, 0, { budget: 850 });
  assert.equal(t.rulings.find((r) => r.itemId === "s")!.stamp, "WAIT");
  assert.notEqual(t.rulings.find((r) => r.itemId === "p")!.stamp, "WAIT");
});

test("store links for anything, and categories from chat", () => {
  const tv = parseLink(world, "https://store.example.com/lg-oled-c5?size=65in");
  assert.equal(tv?.kind, "product");
  assert.equal(tv?.kind === "product" && tv.product.id, "lg-oled-c5");
  assert.equal(tv?.kind === "product" && tv.variant, "65in");
  const mattress = parseLink(world, "https://shop.example.com/casper-original-queen");
  assert.equal(mattress?.kind === "product" && mattress.variant, "Queen");
  const ph = parseLink(world, "https://store.example.com/iphone-17-pro-max?storage=512");
  assert.equal(ph?.kind === "phone" && ph.phone.id, "iphone-17-pro-max");
  assert.equal(findCategory(world, "what laptop should Maya get?"), "laptop");
  assert.equal(findCategory(world, "we need an air fryer"), "kitchen");
  assert.equal(findCategory(world, "court, rule"), undefined);
});

test("product picks respect a budget and a brand", () => {
  const picks = recommendProducts(world, "maya", "laptop", { budget: 700 });
  assert.ok(picks.length >= 2 && picks.every((p) => p.price <= 700));
  assert.equal(recommendProducts(world, "marco", "tv", { brand: "LG" })[0].productId, "lg-oled-c5");
});
