// Where proposals meet: an overrule and the welcome both price a cracked phone's trade-in honestly.
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
const { welcome } = await import("../src/claims.ts");
const say = (memberId: string, text: string) => handle({ spaceId: `sim:dm:${memberId}`, isGroup: false, memberId, text });

test("an overruled phone with a cracked screen gets the cracked trade-in, not the full one", async () => {
  store.reset();
  callTool("add_phone_to_cart", { member: "maya", phone: "iphone-17-pro-max", storageGB: 512, addedBy: "maya" });
  callTool("enter_evidence", { member: "maya", screenCracked: true, finding: "Cracked screen" });
  await say("marco", "court, rule");
  await say("marco", "court, overrule for Maya");
  const r = store.state.trial!.rulings.find((x) => x.memberId === "maya" && x.proposed)!;
  assert.ok(r.overruled);
  assert.ok(r.tradeIn!.value < 260, `trade-in ${r.tradeIn!.value} should be below the $260 uncracked value`);
  assert.ok(r.reasons.some((x) => /cracked|Fix the screen first/.test(x)));
  assert.match(welcome("maya"), /in trade \(cracked screen\)/);
});
