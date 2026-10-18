// Hand-me-downs: a parent's old phone for a teen, priced honestly against trading it in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CART_COURT_DATA_DIR = mkdtempSync(join(tmpdir(), "cart-court-test-"));
for (const k of ["MONGODB_URI", "GEMINI_API_KEY", "PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET"]) delete process.env[k];

const store = await import("../src/store.ts");
const { callTool } = await import("../src/tools.ts");
const { runTrial, handMeDownText } = await import("../src/engine.ts");

const trial = (day: number, mayaOld: boolean) => {
  store.reset();
  const maya = store.world.household.members.find((m) => m.id === "maya")!;
  const saved = { ...maya.device };
  if (mayaOld) Object.assign(maya.device, { model: "iPhone 12", ageMonths: 44, batteryHealth: 74, installmentsLeft: 0 });
  callTool("add_phone_to_cart", { member: "maya", phone: "iphone-17", storageGB: 256, addedBy: "maya" });
  callTool("add_phone_to_cart", { member: "marco", phone: "iphone-17-pro", storageGB: 256, addedBy: "marco" });
  try { return runTrial(store.world, store.state.cart, day, store.trialOpts()).rulings.find((r) => r.memberId === "maya")!; }
  finally { Object.assign(maya.device, saved); }
};

test("no hand-me-down when the parent's phone isn't an upgrade (the demo family)", () => {
  assert.equal(trial(0, false).handMeDown, undefined);
});

test("while a trade-in deal is on, trading the phone in wins, and the court says so", () => {
  const r = trial(0, true);
  assert.equal(r.handMeDown!.saves, -23);
  assert.match(handMeDownText(store.world, r)!, /would cost \$23 more than trading it in/);
  assert.equal(r.stamp, "KEEP"); // a hand-me-down never changes the ruling by itself
});

test("once the deal is over, the hand-me-down saves money", () => {
  const r = trial(200, true);
  assert.deepEqual({ forgone: r.handMeDown!.forgone, saves: r.handMeDown!.saves }, { forgone: 380, saves: 289 });
  assert.match(handMeDownText(store.world, r)!, /Maya takes Marco's iPhone 15 Pro \(89% battery\) on day 200.*\$289 less/);
});

test("\"why?\" mentions the hand-me-down when there is one", async () => {
  const { explain } = await import("../src/appeal.ts");
  store.reset();
  const maya = store.world.household.members.find((m) => m.id === "maya")!;
  const saved = { ...maya.device };
  Object.assign(maya.device, { model: "iPhone 12", ageMonths: 44, batteryHealth: 74, installmentsLeft: 0 });
  try {
    store.state.day = 200;
    callTool("add_phone_to_cart", { member: "maya", phone: "iphone-17", storageGB: 256, addedBy: "maya" });
    callTool("add_phone_to_cart", { member: "marco", phone: "iphone-17-pro", storageGB: 256, addedBy: "marco" });
    store.state.trial = runTrial(store.world, store.state.cart, 200, store.trialOpts());
    assert.match(explain("maya", undefined, () => false), /• Hand-me-down option: Maya takes Marco's iPhone 15 Pro/);
  } finally { Object.assign(maya.device, saved); }
});
