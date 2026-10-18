// Appeals and overrules through the rules path, against the example family in a throwaway data folder.
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
const { describeChanges, snapshot } = await import("../src/feed.ts");

const say = (memberId: string, text: string) => handle({ spaceId: `sim:dm:${memberId}`, isGroup: false, memberId, text });
const ruled = async () => {
  store.reset();
  callTool("add_phone_to_cart", { member: "maya", phone: "iphone-17-pro-max", storageGB: 512, addedBy: "maya" });
  callTool("add_phone_to_cart", { member: "marco", phone: "iphone-17-pro", storageGB: 256, addedBy: "marco" });
  await say("marco", "court, rule");
};
const ruling = (memberId: string) => store.state.trial!.rulings.find((r) => r.memberId === memberId && r.proposed)!;

test("an appeal with no reason asks why, and lists only what would really change the ruling", async () => {
  await ruled();
  const r = (await say("maya", "I appeal"))!;
  assert.match(r, /will hear your appeal/);
  assert.match(r, /Battery Health under 80%/);
  assert.match(r, /Pro camera/);
  assert.match(r, /overrule for Maya/);
  assert.equal(ruling("maya").stamp, "WAIT"); // nothing changed yet
});

test("arguing for the camera keeps the Pro Max, but the payments still make it wait", async () => {
  await ruled();
  await say("maya", "I appeal");
  const r = (await say("maya", "I shoot video for school and need the camera"))!;
  assert.match(r, /PARTLY GRANTED/);
  assert.equal(ruling("maya").proposed?.phoneId, "iphone-17-pro-max");
  assert.equal(ruling("maya").stamp, "WAIT");
  assert.match(r, /payments/);
  // She picked 512GB; the court keeps the Pro Max at 256GB and says why, rather than "you keep" her pick.
  assert.match(r, /You keep the iPhone 17 Pro Max, at 256GB\. 512GB is overkill/);
});

test("a worn battery wins the appeal: buy now", async () => {
  await ruled();
  const r = (await say("marco", "that's not fair, my battery is at 76%"))!;
  assert.match(r, /APPEAL GRANTED/);
  assert.equal(ruling("marco").stamp, "KEEP");
});

test("a denied appeal says why and what would change it", async () => {
  await ruled();
  const r = (await say("marco", "I appeal, I want it for the camera"))!;
  assert.match(r, /APPEAL DENIED/);
  assert.match(r, /89% battery health/);
  assert.match(r, /What would change it/);
});

test("kids can't overrule; a parent can, the cost is on the record, and it can be reinstated", async () => {
  await ruled();
  assert.match((await say("maya", "court, overrule"))!, /Only a parent/);
  const before = snapshot();
  const r = (await say("elena", "court, overrule for maya"))!;
  assert.match(r, /Overruled/);
  assert.equal(ruling("maya").stamp, "KEEP");
  assert.equal(ruling("maya").proposed?.label, "iPhone 17 Pro Max 512GB");
  assert.ok(ruling("maya").overruled!.extra > 0);
  assert.match(describeChanges(before, "elena").join("\n"), /Elena overruled the court/);
  // The overrule survives a fresh trial
  await say("marco", "court, rule");
  assert.equal(ruling("maya").stamp, "KEEP");
  await say("elena", "court, reinstate maya's ruling");
  assert.equal(ruling("maya").stamp, "WAIT");
});

test("a pending appeal doesn't swallow an unrelated question", async () => {
  await ruled();
  await say("maya", "I appeal");
  assert.match((await say("maya", "what case should I get?"))!, /Picks for your iPhone/);
  assert.equal(ruling("maya").proposed?.phoneId, "iphone-17"); // still the court's pick
});

test("the case file shows the latest appeal for each ruling", async () => {
  await ruled();
  await say("maya", "I appeal, I shoot video and need the camera");
  const s = store.publicState();
  assert.equal(s.appeals.length, 1);
  assert.equal(s.appeals[0].outcome, "PARTLY GRANTED");
});

test("a reason the court can't weigh gets a real answer, not the same question again", async () => {
  await ruled();
  const r = (await say("maya", "I appeal, everyone at school has one"))!;
  assert.match(r, /APPEAL DENIED, Maya/);
  assert.match(r, /The ruling stands: WAIT till day 120/);
  assert.match(r, /What would change it/);
  // Same when the reason comes after "tell me why"
  await say("maya", "I appeal");
  assert.match((await say("maya", "everyone at school has one"))!, /APPEAL DENIED/);
  assert.equal(ruling("maya").stamp, "WAIT");
});

test("\"ok fine\" after \"tell me why\" withdraws the appeal", async () => {
  await ruled();
  await say("maya", "I appeal");
  assert.match((await say("maya", "ok fine"))!, /Appeal withdrawn\. The ruling stands/);
  assert.equal(store.state.pendingAppeal?.maya, undefined);
});

test("a battery-health report is evidence, not a wish for a bigger battery (no free Pro Max)", async () => {
  await ruled();
  const r = (await say("maya", "I appeal, my battery is at 76%"))!;
  assert.match(r, /APPEAL GRANTED/);
  assert.equal(ruling("maya").proposed?.phoneId, "iphone-17");
  assert.equal(store.state.prefs.maya?.battery, undefined);
});
