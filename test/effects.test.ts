// iMessage send effects: only the verdict and "it's time" get one, and a failed effect still delivers the text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CART_COURT_DATA_DIR = mkdtempSync(join(tmpdir(), "cart-court-test-"));
for (const k of ["MONGODB_URI", "GEMINI_API_KEY", "PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET"]) delete process.env[k];

const { effectFor } = await import("../src/effects.ts");
const { registerChannel, sendTo } = await import("../src/channels/index.ts");
const { handle } = await import("../src/agent.ts");
const store = await import("../src/store.ts");
const { callTool } = await import("../src/tools.ts");

test("the verdict slams, 'it's time' gets confetti, everything else is plain", () => {
  assert.equal(effectFor("⚖️ THE COURT RULES\nMaya: WAIT"), "slam");
  assert.equal(effectFor("⏳➡️✅ Maya, it's time."), "confetti");
  assert.equal(effectFor("📥 Maya added iPhone 17 to the family cart."), undefined);
  assert.equal(effectFor("Order in the court. ⚖️ THE COURT RULES"), undefined); // only a leading verdict
});

test("CART_COURT_EFFECTS=off turns them off", () => {
  process.env.CART_COURT_EFFECTS = "off";
  try { assert.equal(effectFor("⚖️ THE COURT RULES"), undefined); }
  finally { delete process.env.CART_COURT_EFFECTS; }
});

test("sendTo hands the effect to the channel and records it for the simulator", async () => {
  const sent: [string, string | undefined][] = [];
  registerChannel("fx", async (_id, text, effect) => { sent.push([text.split("\n")[0], effect]); });
  store.reset();
  callTool("add_phone_to_cart", { member: "maya", phone: "iphone-17-pro-max", storageGB: 512, addedBy: "maya" });
  const verdict = (await handle({ spaceId: "fx:maya", isGroup: false, memberId: "maya", text: "court, rule" }))!;
  await sendTo("fx:maya", verdict, true);
  await sendTo("fx:maya", "Got it.", true);
  assert.deepEqual(sent, [["⚖️ THE COURT RULES", "slam"], ["Got it.", undefined]]);
  assert.equal(store.state.chat.at(-2)?.effect, "slam");
  assert.equal("effect" in store.state.chat.at(-1)!, false);
});
