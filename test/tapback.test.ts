// Tapbacks (👎 appeals a ruling, ❓ asks why) and "why?" questions, against the example family.
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
const { tapbackLog, tapbackText } = await import("../src/tapback.ts");

const say = (memberId: string, text: string) => handle({ spaceId: `sim:dm:${memberId}`, isGroup: false, memberId, text });
const ruled = async () => {
  store.reset();
  callTool("add_phone_to_cart", { member: "maya", phone: "iphone-17-pro-max", storageGB: 512, addedBy: "maya" });
  callTool("add_phone_to_cart", { member: "marco", phone: "iphone-17-pro", storageGB: 256, addedBy: "marco" });
  callTool("add_phone_to_cart", { member: "elena", phone: "pixel-10-pro", storageGB: 256, addedBy: "elena" });
  return (await say("marco", "court, rule"))!;
};

test("👎 on the verdict appeals it, ❓ asks why, and the rest are applause", async () => {
  const verdict = await ruled();
  assert.ok(verdict.includes("Disagree? Tap 👎 on this to appeal, or ❓ to ask why."));
  assert.equal(tapbackText("👎", verdict, true), "I appeal");
  assert.equal(tapbackText("❓", verdict, true), "why?");
  for (const e of ["👍", "❤️", "😂", "‼️"]) assert.equal(tapbackText(e, verdict, true), undefined);
  // Only the court's own rulings: not someone's text, not the help menu.
  assert.equal(tapbackText("👎", "⚖️ THE COURT RULES", false), undefined);
  assert.equal(tapbackText("👎", "⚖️ The court is listening. You can:", true), undefined);
  assert.equal(tapbackText("👎", undefined, true), undefined);
  // A message about one person's ruling is about that person.
  assert.equal(tapbackText("👎", "⚖️ APPEAL DENIED, Maya. Pro features…", true), "I appeal for Maya");
  assert.equal(tapbackText("❓", "⚖️ Why Marco's ruling is WAIT till day 41", true), "why Marco?");
});

test("the tapback reaches the same courtroom as typing it", async () => {
  const verdict = await ruled();
  assert.match((await say("maya", tapbackText("👎", verdict, true)!))!, /will hear your appeal, Maya/);
  const why = (await say("maya", tapbackText("❓", verdict, true)!))!;
  assert.match(why, /Why your ruling is WAIT till day 120/);
  assert.match(why, /88% battery health/);
  assert.match(why, /I appeal/);
});

test("the chat log reads like iMessage's own tapback fallback", () => {
  assert.equal(tapbackLog("👎", "⚖️ THE COURT RULES\n⏳ WAIT…"), "Disliked “⚖️ THE COURT RULES”");
  assert.equal(tapbackLog("❓", "⚖️ The court will hear your appeal, Maya. Current ruling"), "Questioned “⚖️ The court will hear your appeal, Maya…”");
});

test("why? explains your ruling, or the one you name; parents are told they can overrule", async () => {
  await ruled();
  assert.match((await say("maya", "why?"))!, /^⚖️ Why your ruling is WAIT till day 120, iPhone 17 256GB for \$670:\n• /);
  assert.match((await say("maya", "why marco?"))!, /Why Marco's ruling is WAIT till day 41/);
  assert.match((await say("maya", "why not the pro max"))!, /Why your ruling/);
  assert.match((await say("elena", "how come"))!, /Why your ruling is BUY: the Pixel 10 Pro/);
  assert.match((await say("marco", "why?"))!, /You're a parent: "court, overrule"/);
  assert.match((await say("elena", "why maya"))!, /"court, overrule for Maya"/);
  const rosa = (await say("rosa", "why?"))!;
  assert.match(rosa, /You don't have a phone in this ruling/);
  assert.match(rosa, /Hotspot Plus/);
});

test("why-questions that aren't about a ruling go where they did before", async () => {
  await ruled();
  assert.match((await say("maya", "why should I get a case?"))!, /Picks for/);
  assert.doesNotMatch((await say("maya", "why is the sky blue"))!, /Why your ruling/);
  store.reset();
  assert.doesNotMatch((await say("maya", "why?"))!, /Why your ruling/); // no ruling yet
});

test("nothing of yours to appeal points at the ruling that's still open", async () => {
  await ruled();
  assert.match((await say("elena", "I appeal"))!, /already said BUY.*"court, overrule for Maya"/);
  assert.match((await say("rosa", "I appeal"))!, /"why Maya\?"/);
});

test("a real Photon tapback event appeals once, even if it's delivered twice", async () => {
  const verdict = await ruled();
  const { receive } = await import("../src/channels/photon.ts");
  const { registerChannel } = await import("../src/channels/index.ts");
  const { claim } = await import("../src/claims.ts");
  claim("+15555550123", "maya");
  const sent: string[] = [];
  registerChannel("photon", async (_id, text) => void sent.push(text));
  const space = { id: "any;-;+15555550123", type: "dm", responding: (fn: () => unknown) => fn() };
  const target = { id: "court-msg-1", direction: "outbound", content: { type: "text", text: verdict } };
  const tap = (emoji: string, id: string) => ({ id, direction: "inbound", sender: { id: "+15555550123" }, content: { type: "reaction", emoji, target } });
  await receive(space as never, tap("👎", "r1") as never);
  await receive(space as never, tap("👎", "r2") as never); // redelivered / toggled: still one appeal
  await receive(space as never, tap("👍", "r3") as never); // applause: logged, not answered
  assert.equal(sent.length, 1);
  assert.match(sent[0], /will hear your appeal, Maya/);
  const log = store.state.chat.filter((l) => l.spaceId === `photon:${space.id}` && l.from === "maya").map((l) => l.text);
  assert.deepEqual(log, ["Disliked “⚖️ THE COURT RULES”", "Liked “⚖️ THE COURT RULES”"]);
});

test("in the group chat a tapback on the verdict still gets an answer (it's addressed to the court)", async () => {
  await ruled();
  const group = (memberId: string, text: string, addressed?: boolean) => handle({ spaceId: "sim:group", isGroup: true, memberId, text, addressed });
  assert.equal(await group("maya", "I appeal"), null); // typed in the group without "court": the court stays quiet
  assert.match((await group("maya", "I appeal", true))!, /will hear your appeal/);
  assert.match((await group("elena", "why?", true))!, /Why your ruling is/);
});

test("after a 👎 in the group, the next text is heard as the reason; lol and questions aren't", async () => {
  await ruled();
  const group = (memberId: string, text: string, addressed = false) => handle({ spaceId: "sim:group", isGroup: true, memberId, text, addressed });
  assert.match((await group("maya", "I appeal", true))!, /will hear your appeal, Maya/);
  assert.equal(await group("maya", "lol"), null);
  assert.equal(await group("maya", "😭"), null);
  assert.equal(await group("elena", "everyone at school has one"), null); // only Maya's appeal is open
  assert.match((await group("maya", "everyone at school has one"))!, /APPEAL DENIED, Maya/);
  assert.equal(await group("maya", "whatever"), null); // the appeal is closed: back to normal group manners
});

test("court, <reason> during an appeal is the reason, but court, rule is still a command", async () => {
  await ruled();
  await say("maya", "I appeal");
  assert.match((await say("maya", "court, everyone at school has one"))!, /APPEAL DENIED, Maya/);
  await say("maya", "I appeal");
  assert.match((await say("maya", "court, what's the status?"))!, /^🛒 Family cart/);
});
