// "What's in the cart?" by text: every item and where it stands, without opening the case file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CART_COURT_DATA_DIR = mkdtempSync(join(tmpdir(), "cart-court-test-"));
for (const k of ["MONGODB_URI", "GEMINI_API_KEY", "PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET"]) delete process.env[k];

const { handle } = await import("../src/agent.ts");
const store = await import("../src/store.ts");
const { callTool } = await import("../src/tools.ts");

const say = (memberId: string, text: string) => handle({ spaceId: `sim:dm:${memberId}`, isGroup: false, memberId, text });
const seed = () => {
  store.reset();
  callTool("add_phone_to_cart", { member: "maya", phone: "iphone-17-pro-max", storageGB: 512, addedBy: "maya" });
  callTool("add_phone_to_cart", { member: "marco", phone: "iphone-17-pro", storageGB: 256, addedBy: "marco" });
  callTool("add_phone_to_cart", { member: "elena", phone: "pixel-10-pro", storageGB: 256, addedBy: "elena" });
};

test("before a ruling: items, sticker total, and the next step", async () => {
  seed();
  const r = (await say("maya", "what's in the cart?"))!;
  if (process.env.SHOW) console.log(r);
  assert.match(r, /^🛒 Family cart, day 0: 3 items, sticker \$3,599/);
  assert.match(r, /Maya's iPhone 17 Pro Max 512GB \(yours\), \$1,\d{3} · not ruled yet/);
  assert.match(r, /say "court, rule"/);
});

test("after a ruling: each item shows buy, or wait till when and for what", async () => {
  seed();
  await say("marco", "court, rule");
  const r = (await say("elena", "where do we stand?"))!;
  if (process.env.SHOW) console.log(r);
  assert.match(r, /Maya's iPhone 17 Pro Max 512GB, \$[\d,]+ · ⏳ wait till day 120, the iPhone 17 256GB: \$670/);
  assert.match(r, /Elena's Pixel 10 Pro 256GB \(yours\), \$[\d,]+ · ✅ buy: \$909/);
  assert.match(r, /Case file:/);
});

test("something added after the ruling is ruled on right away", async () => {
  seed();
  await say("marco", "court, rule");
  callTool("add_phone_to_cart", { member: "rosa", phone: "iphone-17", storageGB: 256, addedBy: "marco" });
  const r = (await say("marco", "status"))!;
  assert.match(r, /4 items/);
  assert.match(r, /Rosa's iPhone 17 256GB, \$930 · ✅ buy: \$930/);
  assert.doesNotMatch(r, /not ruled yet/);
});

test("an empty cart says how to start", async () => {
  store.reset();
  assert.match((await say("maya", "show me the cart"))!, /empty[\s\S]*what phone should I get/);
});

test("adding or clearing the cart isn't mistaken for a status check", async () => {
  seed();
  assert.doesNotMatch((await say("marco", "clear the cart"))!, /🛒 Family cart/);
  assert.doesNotMatch((await say("maya", "add the iPhone 17 for me to the cart"))!, /🛒 Family cart/);
});

test("the everyday ways of asking for the status all work", async () => {
  seed();
  for (const t of ["whats the status?", "status update pls", "where are we at", "what is the status of my phone"]) assert.match((await say("maya", t))!, /🛒 Family cart/, t);
  assert.doesNotMatch((await say("maya", "is the status bar fixed on the 17?"))!, /🛒 Family cart/);
});

test("thanks and ok get a short answer, not the whole menu", async () => {
  seed();
  assert.equal(await say("maya", "thanks court"), "⚖️ Anytime. The court stands by.");
  assert.equal(await say("maya", "ok"), "⚖️ Noted.");
  assert.match((await say("maya", "hi"))!, /The court is listening/);
});

test("\"my screen is cracked\" in a DM asks for the photo instead of showing the menu", async () => {
  seed();
  assert.match((await say("marco", "my screen is cracked"))!, /Send a photo of the screen/);
});

test("what do we pay a month? adds up the ruled phones", async () => {
  seed();
  assert.match((await say("marco", "what do we pay a month?"))!, /Nothing's ruled yet/);
  await say("marco", "court, rule");
  const r = (await say("marco", "what do we pay a month?"))!;
  if (process.env.SHOW) console.log(r);
  assert.match(r, /^💵 New phones, about \$83\/mo together/);
  assert.match(r, /Maya's iPhone 17 256GB: ≈\$28\/mo from day 120/);
  assert.match(r, /Elena's Pixel 10 Pro 256GB: ≈\$38\/mo$/m);
  assert.match((await say("marco", "monthly"))!, /^💵/);
  assert.doesNotMatch((await say("marco", "I got my phone a month ago"))!, /^💵/);
});

test("ok fine after a denied appeal is just noted", async () => {
  seed();
  assert.equal(await say("maya", "ok fine"), "⚖️ Noted.");
  assert.equal(await say("maya", "fine"), "⚖️ Noted.");
});

test("who gets my old phone? names the trade-in and what it's worth", async () => {
  seed();
  assert.match((await say("maya", "who gets my old phone?"))!, /stays with you: nothing's ruled for Maya yet/);
  await say("marco", "court, rule");
  const r = (await say("maya", "who gets my old phone?"))!;
  if (process.env.SHOW) console.log(r);
  assert.match(r, /^📱 Trade it in on day 120: your iPhone 14 is worth \$260, already counted in the \$670 price \(\$930 if you keep it as a backup\)/);
  assert.match((await say("elena", "what happens to my phone?"))!, /^📱 Trade it in today/);
});
