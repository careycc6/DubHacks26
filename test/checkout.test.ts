// "Place mock order" buys what the court said to buy today: the money comes off the family budget and each
// new phone replaces the one on file (100% battery). Undoing the purchase puts the old phone back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.CART_COURT_DATA_DIR = mkdtempSync(join(tmpdir(), "cart-court-test-"));
for (const k of ["MONGODB_URI", "GEMINI_API_KEY", "PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET"]) delete process.env[k];

const store = await import("../src/store.ts");
const { callTool } = await import("../src/tools.ts");
const { dashboardRouter } = await import("../src/dashboard.ts");
const express = (await import("express")).default;
const app = express();
app.use(express.json());
app.use(dashboardRouter);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => server.close());
const post = (path: string, body: unknown = {}) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const elena = () => store.world.household.members.find((m) => m.id === "elena")!;

test("placing the order buys today's items, spends the budget, and puts the new phones on file", async () => {
  store.reset();
  store.state.budget = 3000;
  callTool("add_phone_to_cart", { member: "elena", phone: "pixel-10-pro", storageGB: 256, addedBy: "elena" });
  callTool("add_phone_to_cart", { member: "maya", phone: "iphone-17-pro-max", storageGB: 512, addedBy: "maya" });
  callTool("run_trial", {});
  const today = store.state.trial!.rulings.filter((r) => r.stamp === "KEEP" || r.stamp === "SWAP");
  const due = today.reduce((s, r) => s + r.nowCost, 0);
  assert.ok(today.some((r) => r.memberId === "elena"));
  const oldModel = elena().device.model;

  const r = await post("/api/dashboard/checkout");
  assert.equal(r.bought.length, today.length);
  assert.equal(r.spent, due);
  assert.equal(r.budgetLeft, 3000 - due);
  assert.deepEqual([elena().device.model, elena().device.batteryHealth, elena().device.ageMonths], ["Pixel 10 Pro", 100, 0]);
  assert.equal(store.state.devices?.elena?.model, "Pixel 10 Pro");
  // Held items stay in the cart for later.
  assert.ok(store.state.cart.some((i) => i.memberId === "maya"));

  // Undo: the old phone is back.
  const p = store.state.purchases.find((x) => x.memberId === "elena")!;
  await post("/api/dashboard/purchase/undo", { id: p.id });
  assert.equal(elena().device.model, oldModel);
  assert.equal(store.state.devices?.elena, undefined);
});

test("a phone logged by text is on file too, and survives a reload", () => {
  store.reset();
  callTool("add_phone_to_cart", { member: "elena", phone: "pixel-10-pro", storageGB: 256, addedBy: "elena" });
  callTool("record_purchase", { member: "elena", paid: 749 });
  assert.equal(elena().device.batteryHealth, 100);
  store.restoreSnapshot(store.snapshot());
  assert.deepEqual([elena().device.model, elena().device.batteryHealth], ["Pixel 10 Pro", 100]);
});

test("moving the purchase to someone else gives the first person their old phone back", () => {
  store.reset();
  const was = elena().device.model;
  callTool("add_phone_to_cart", { member: "elena", phone: "pixel-10-pro", storageGB: 256, addedBy: "elena" });
  callTool("record_purchase", { member: "elena", paid: 749 });
  callTool("reassign_purchase", { member: "marco" });
  assert.equal(elena().device.model, was);
  assert.equal(store.world.household.members.find((m) => m.id === "marco")!.device.model, "Pixel 10 Pro");
});
