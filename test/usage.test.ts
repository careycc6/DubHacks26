// "What phone should I get?" first asks how the person uses a phone (camera, games 1-5), then picks with that.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CART_COURT_DATA_DIR = mkdtempSync(join(tmpdir(), "cart-court-test-"));
for (const k of ["MONGODB_URI", "GEMINI_API_KEY", "PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET"]) delete process.env[k];

const { handle, parseUsage } = await import("../src/agent.ts");
const store = await import("../src/store.ts");
const say = (memberId: string, text: string) => handle({ spaceId: `sim:dm:${memberId}`, isGroup: false, memberId, text });

test("reads the everyday ways of answering", () => {
  assert.deepEqual(parseUsage("camera 4, games 1"), { camera: 4, gaming: 1 });
  assert.deepEqual(parseUsage("4 and 2"), { camera: 4, gaming: 2 });
  assert.deepEqual(parseUsage("I take photos all the time, never play games"), { camera: 5, gaming: 1 });
  assert.equal(parseUsage("not sure yet"), undefined);
});

test("asks once, uses the answer, and remembers it", async () => {
  store.reset();
  assert.match((await say("maya", "what phone should I get?"))!, /on a scale of 1 to 5, how much do you use the camera/);
  const r = (await say("maya", "camera 5, games 2"))!;
  assert.match(r, /Noted: camera 5\/5, games 2\/5 for you/);
  assert.match(r, /picks for/i);
  assert.deepEqual(store.state.usage?.maya, { camera: 5, gaming: 2 });
  assert.equal(store.world.household.members.find((m) => m.id === "maya")!.usage.camera, 5);
  assert.match((await say("maya", "what phone should I get?"))!, /picks for/i); // not asked again
});

test("asking for someone else asks about them; skip goes by their current phone", async () => {
  store.reset();
  assert.match((await say("marco", "what phone should Elena get?"))!, /picks for Elena: on a scale.*does Elena use the camera/);
  assert.doesNotMatch((await say("marco", "skip"))!, /Noted/);
  assert.ok(store.state.usage?.elena);
});

test("a named model or a stated wish skips the question", async () => {
  store.reset();
  assert.match((await say("maya", "what phone should I get with a big screen?"))!, /picks for/i);
  assert.match((await say("marco", "what iphone 18 should I get?"))!, /iPhone 18 Pro/);
});
