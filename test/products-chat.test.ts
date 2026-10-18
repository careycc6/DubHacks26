// Shopping for anything over chat, in rules mode (no Gemini key), against the real store (nothing saved to disk).
process.env.CART_COURT_DB = "memory";
delete process.env.GEMINI_API_KEY;
import { test } from "node:test";
import assert from "node:assert/strict";

const store = await import("../src/store.ts");
const { handle } = await import("../src/agent.ts");
const say = (memberId: string, text: string) => handle({ spaceId: `sim:${memberId}`, isGroup: false, memberId, text });

test("recommend, add, link, custom item, broken vacuum, rule", async () => {
  store.reset();
  const picks = await say("maya", "court, what laptop should I get under $700?");
  assert.match(picks!, /laptop picks for you/);
  assert.match(await say("maya", "add the first one") ?? "", /Asked Marco and Elena to OK it/);
  assert.equal(store.state.cart.length, 0);
  assert.match(await say("marco", "approve") ?? "", /Lenovo/);
  assert.equal(store.state.cart[0].kind, "product");

  assert.match(await say("marco", "https://store.example.com/lg-oled-c5?size=65in") ?? "", /LG OLED C6 65in/);
  assert.match(await say("rosa", "court, add a $90 air purifier for me") ?? "", /OK it: air purifier/);
  assert.match(await say("elena", "approve rosa's") ?? "", /air purifier/);
  assert.match(await say("elena", "court, add the shark stratos for elena") ?? "", /Shark Stratos/);
  assert.match(await say("elena", "court, the vacuum died") ?? "", /broken/);
  assert.match(await say("elena", "court, add a sofa for me") ?? "", /what it costs/);

  const verdict = (await say("marco", "court, rule"))!;
  assert.match(verdict, /THE COURT RULES/);
  assert.match(verdict, /WAIT \d+ days: Marco · LG OLED C6 65in/); // Black Friday
  assert.match(verdict, /BUY: Elena · Shark Stratos Cordless/); // the old one is broken
  assert.match(verdict, /BUY: Rosa · air purifier · \$90 today/);
});
