// A real family's names: "add … for kairui cheng" finds Kairui Cheng by full name, first name or last name.
process.env.CART_COURT_DB = "memory";
delete process.env.GEMINI_API_KEY;
import { test } from "node:test";
import assert from "node:assert/strict";

const store = await import("../src/store.ts");
const { handle } = await import("../src/agent.ts");
const say = (memberId: string, text: string) => handle({ spaceId: `sim:${memberId}`, isGroup: false, memberId, text });

test("a member is found by full, first or last name", async () => {
  store.reset();
  const names: Record<string, string> = { marco: "Carey Chiu", elena: "Kairui Cheng", maya: "Jaret Zheng", rosa: "Rosa" };
  const before = store.world.household.members.map((m) => m.name);
  for (const m of store.world.household.members) if (names[m.id]) m.name = names[m.id];
  try {
    const full = (await say("marco", "court add iphone 18 for kairui cheng"))!;
    assert.match(full, /Added to the family cart: .*iPhone 18 Pro/);
    assert.match(full, /closest match for "iphone 18"/);
    assert.equal(store.state.cart.at(-1)!.memberId, "elena");

    assert.match((await say("marco", "court add the pixel 10 for jaret"))!, /Added/);
    assert.equal(store.state.cart.at(-1)!.memberId, "maya");
    assert.match((await say("marco", "court add the iphone 17 for zheng"))!, /Added/);
    assert.equal(store.state.cart.at(-1)!.memberId, "maya");
    assert.match((await say("marco", "court add the iphone 17 for bob"))!, /No household member "bob"/);
  } finally {
    store.world.household.members.forEach((m, i) => (m.name = before[i]));
  }
});
