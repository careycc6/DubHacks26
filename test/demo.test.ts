// Demo checkpoints and the pre-trial scene, against the real store (nothing is saved to disk).
process.env.CART_COURT_DB = "memory";
import { test } from "node:test";
import assert from "node:assert/strict";

const store = await import("../src/store.ts");
const { loadPrefiledScene } = await import("../src/demo.ts");
const { callTool } = await import("../src/tools.ts");
const { advanceTrial } = await import("../src/engine.ts");

test("the pre-trial scene rules exactly like DEMO.md", () => {
  loadPrefiledScene();
  assert.equal(store.state.cart.length, 3);
  assert.equal(store.state.trial, undefined);
  callTool("run_trial", {});
  const t = store.state.trial!;
  assert.equal(t.before, 3935);
  assert.equal(t.now, 709); // Kairui's private "money is tight" is part of the scene
  assert.equal(t.savings, 2248);
});

test("restoring a checkpoint puts the court back exactly, evidence included", () => {
  loadPrefiledScene();
  const snap = store.snapshot();
  const before = JSON.stringify(store.publicState());

  callTool("enter_evidence", { member: "marco", finding: "Cracked screen", screenCracked: true });
  callTool("run_trial", {});
  store.state.day = 41;
  store.state.trial = advanceTrial(store.world, store.state.cart, store.state.trial, 41, store.trialOpts());
  assert.notEqual(JSON.stringify(store.publicState()), before);

  store.restoreSnapshot(snap);
  assert.equal(JSON.stringify(store.publicState()), before);
  assert.equal(store.world.household.members.find((m) => m.id === "marco")!.device.screenCracked, undefined);
  assert.deepEqual(store.state.privateNotes.elena, ["honestly money is tight this month, don't tell the kids"]);
});
