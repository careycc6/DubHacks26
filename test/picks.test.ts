// "court add an iphone 18" adds it for whoever texted; "what iphone 18 should I get?" shows the iPhone 18 line
// at T-Mobile's price, what gets traded in and where, T-Mobile's deal, and every store (Amazon too).
process.env.CART_COURT_DB = "memory";
delete process.env.GEMINI_API_KEY;
import { test } from "node:test";
import assert from "node:assert/strict";

const store = await import("../src/store.ts");
const { handle } = await import("../src/agent.ts");
const say = (memberId: string, text: string) => handle({ spaceId: `sim:${memberId}`, isGroup: false, memberId, text });

test("an inexact phone shows options (other iPhones and Pixels too) instead of adding a guess", async () => {
  store.reset();
  const r = (await say("maya", "court add an iphone 18"))!;
  assert.match(r, /picks for you/);
  assert.match(r, /the line is iPhone 18 Pro and iPhone 18 Pro Max/);
  assert.match(r, /\nOther ideas: 4\. .*Pixel/);
  assert.equal(store.state.cart.length, 0);
  // A kid picking one asks a parent; the parent's "approve" puts it in the cart.
  assert.match((await say("maya", "add the first one"))!, /Asked Marco and Elena to OK it: iPhone 18 Pro 256GB for Maya/);
  assert.equal(store.state.cart.length, 0);
  await say("marco", "approve");
  assert.deepEqual([store.state.cart[0].phoneId, store.state.cart[0].memberId], ["iphone-18-pro", "maya"]);
  // Not phones or products: still handled by their own commands.
  assert.match((await say("maya", "court add protection"))!, /Protection 360/);
  assert.match((await say("maya", "court add a case"))!, /Case/);
});

test("picks honor the model asked about, with trade-in, deal and stores", async () => {
  store.reset();
  const r = (await say("maya", "court, what iphone 18 should I get?"))!;
  assert.match(r, /There's no plain iPhone 18: the line is iPhone 18 Pro and iPhone 18 Pro Max/);
  assert.match(r, /\n1\. iPhone 18 Pro 256GB, \$1,200 at T-Mobile \(\$940 after trading in your iPhone 14\)/);
  assert.match(r, /\n2\. iPhone 18 Pro Max /);
  assert.match(r, /♻️ Trade-in: your iPhone 14, worth about \$260 at T-Mobile/);
  assert.match(r, /📣 T-Mobile deal on #1: up to \$1,000 off/);
  for (const s of ["Apple", "T-Mobile", "Best Buy", "Amazon"]) assert.match(r, new RegExp(`\\n   ${s}[ :]`));
  assert.match(r, /🎧 Pairs well with/);
});
