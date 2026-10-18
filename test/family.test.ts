// Once a family is set up on /setup, it's only the people saved there: an example slot left blank (grandma) drops out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CART_COURT_DATA_DIR = mkdtempSync(join(tmpdir(), "cart-court-test-"));
for (const k of ["MONGODB_URI", "GEMINI_API_KEY", "PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET"]) delete process.env[k];

const { loadWorld, saveHouseholdLocal } = await import("../src/data.ts");

test("the example family has everyone until someone is saved", () => {
  saveHouseholdLocal({ members: {} });
  assert.deepEqual(loadWorld().household.members.map((m) => m.id), ["marco", "elena", "maya", "rosa"]);
});

test("a saved family leaves out the slots nobody filled in", () => {
  saveHouseholdLocal({ members: { marco: { name: "Carey Chiu", role: "parent" }, elena: { name: "Kairui Cheng" }, maya: { name: "Jaret Zhang", role: "teen" } } });
  const w = loadWorld();
  assert.deepEqual(w.household.members.map((m) => m.name), ["Carey Chiu", "Kairui Cheng", "Jaret Zhang"]);
  assert.equal(loadWorld({ local: false }).household.members.length, 4); // tests and setup's blank rows still see every slot
});

test("asking for Grandma when she isn't in the family says so", async () => {
  const store = await import("../src/store.ts");
  const { handle } = await import("../src/agent.ts");
  store.reset();
  const before = store.world.household.members;
  store.world.household.members = before.filter((m) => m.id !== "rosa");
  try {
    const r = await handle({ spaceId: "sim:maya", isGroup: false, memberId: "maya", text: "court, what phone should grandma get?" });
    assert.match(r!, /Grandma isn't in your family/);
  } finally { store.world.household.members = before; }
});
