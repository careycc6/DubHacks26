// The first reply after "I'm Maya": what the court knows, and things to text that really work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CART_COURT_DATA_DIR = mkdtempSync(join(tmpdir(), "cart-court-test-"));
for (const k of ["MONGODB_URI", "GEMINI_API_KEY", "PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET"]) delete process.env[k];

const { welcome } = await import("../src/claims.ts");
const { handle } = await import("../src/agent.ts");
const store = await import("../src/store.ts");
const { callTool } = await import("../src/tools.ts");

const say = (memberId: string, text: string) => handle({ spaceId: `sim:dm:${memberId}`, isGroup: false, memberId, text });

test("a teen sees their phone on file, what's already in the cart for them, and what to try", () => {
  store.reset();
  callTool("add_phone_to_cart", { member: "maya", phone: "iphone-17-pro-max", storageGB: 512, addedBy: "marco" });
  const w = welcome("maya");
  if (process.env.SHOW) console.log(w + "\n---");
  assert.match(w, /On file: your iPhone 14 \(88% battery health · 4 payments of \$25 left · worth \$260 in trade\)/);
  assert.match(w, /Already in the family cart for you: iPhone 17 Pro Max 512GB/);
  assert.doesNotMatch(w, /budget is/); // parents only
});

test("a parent also learns about the family budget", () => {
  store.reset();
  const w = welcome("marco");
  if (process.env.SHOW) console.log(w + "\n---");
  assert.match(w, /our phone budget is \$2,000/);
  assert.doesNotMatch(w, /Already in the family cart/);
});

test("a grandparent gets the short, plain version", () => {
  store.reset();
  const w = welcome("rosa");
  if (process.env.SHOW) console.log(w + "\n---");
  assert.ok(w.split("\n").length <= 3);
  assert.doesNotMatch(w, /battery health|trade|budget/i);
});

test("every example in the welcome does what it says", async () => {
  store.reset();
  assert.match((await say("maya", "battery health 79%"))!, /Battery health 79%/);
  assert.match((await say("maya", "what phone should I get?"))!, /picks for/i);
  assert.match((await say("rosa", "I want a phone that's easy to read"))!, /picks for/i);
  assert.match((await say("marco", "our phone budget is $2,000"))!, /budget set: \$2,000/);
  callTool("add_phone_to_cart", { member: "maya", phone: "iphone-17-pro-max", storageGB: 512, addedBy: "maya" });
  assert.match((await say("maya", "court, rule"))!, /THE COURT RULES/);
});
