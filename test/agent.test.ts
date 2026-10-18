// Text-message flows through the rules path (no Gemini, no Photon, no MongoDB), against the example family
// in a throwaway data folder so your real household is never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CART_COURT_DATA_DIR = mkdtempSync(join(tmpdir(), "cart-court-test-"));
for (const k of ["MONGODB_URI", "GEMINI_API_KEY", "PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET"]) delete process.env[k];

const { handle } = await import("../src/agent.ts");
const store = await import("../src/store.ts"); // read store.state live: reset() replaces it
const { callTool } = await import("../src/tools.ts");

const IMG = { mimeType: "image/png", base64: "iVBORw0KGgo=" };
const say = (memberId: string, text: string, image?: typeof IMG) =>
  handle({ spaceId: `sim:dm:${memberId}`, isGroup: false, memberId, text, image });
const fresh = () => {
  store.reset();
  store.state.pendingClear = {};
  store.state.pendingReceipt = {};
};

test("a kid can't clear the cart; a parent needs to confirm with YES", async () => {
  fresh();
  callTool("add_phone_to_cart", { member: "maya", phone: "iphone-17", storageGB: 256, addedBy: "maya" });
  assert.match((await say("maya", "cart clear"))!, /Only a parent/);
  assert.equal(store.state.cart.length, 1);
  assert.match((await say("elena", "cart clear"))!, /YES/);
  assert.equal(store.state.cart.length, 1);
  assert.match((await say("elena", "yes"))!, /Cart cleared/);
  assert.equal(store.state.cart.length, 0);
});

test("\"nope\" cancels a pending clear", async () => {
  fresh();
  callTool("add_phone_to_cart", { member: "maya", phone: "iphone-17", storageGB: 256, addedBy: "maya" });
  await say("marco", "cart clear");
  assert.match((await say("marco", "nope"))!, /stays/);
  assert.equal(store.state.cart.length, 1);
});

test("a kid can't remove someone else's item, but can remove their own", async () => {
  fresh();
  callTool("add_phone_to_cart", { member: "marco", phone: "iphone-17-pro", storageGB: 256, addedBy: "marco" });
  callTool("add_phone_to_cart", { member: "maya", phone: "iphone-17", storageGB: 256, addedBy: "maya" });
  assert.match((await say("maya", "remove marco's phone"))!, /Only a parent/);
  assert.equal(store.state.cart.length, 2);
  await say("maya", "remove my phone");
  assert.deepEqual(store.state.cart.map((i) => i.memberId), ["marco"]);
});

test("a kid logs their own purchase by text", async () => {
  fresh();
  await say("maya", "I bought my iPhone 17 Pro Max for $1199");
  assert.equal(store.state.purchases.at(-1)?.memberId, "maya");
});

test("a kid needs a receipt to log a purchase as someone else's", async () => {
  fresh();
  assert.match((await say("maya", "I bought marco his iPhone 17 Pro for $999"))!, /receipt/);
  assert.equal(store.state.purchases.length, 0);
  // The photo that follows completes it.
  assert.match((await say("maya", "", IMG))!, /Marco's new phone/);
  assert.equal(store.state.purchases.at(-1)?.memberId, "marco");
});

test("a receipt photo first, then the total", async () => {
  fresh();
  assert.match((await say("maya", "bought this for rosa", IMG))!, /What was the total/);
  await say("maya", "paid $399");
  assert.equal(store.state.purchases.at(-1)?.memberId, "rosa");
});

test("a parent can log a purchase for anyone without a receipt", async () => {
  fresh();
  await say("elena", "bought maya an iPhone 17 for $799");
  assert.equal(store.state.purchases.at(-1)?.memberId, "maya");
});

test("battery health by DM is evidence", async () => {
  fresh();
  assert.match((await say("marco", "battery health 72%"))!, /Exhibit/);
});
