// A cracked screen lowers the trade-in, and the court says when fixing it first pays.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CART_COURT_DATA_DIR = mkdtempSync(join(tmpdir(), "cart-court-test-"));
for (const k of ["MONGODB_URI", "GEMINI_API_KEY", "PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET"]) delete process.env[k];

const store = await import("../src/store.ts");
const { callTool } = await import("../src/tools.ts");
const { tradeIn } = await import("../src/engine.ts");

const device = (tradeInValue: number, screenCracked = true) =>
  ({ name: "Sam", device: { model: "Phone", tradeInValue, screenCracked } }) as Parameters<typeof tradeIn>[0];

test("cracked: fix it first when the repair costs less than the value it restores", () => {
  const t = tradeIn(device(380));
  assert.equal(t.value, 251); // $380 after a $129 repair beats ~$150 cracked
  assert.match(t.reason, /Fix the screen first \(\$129\).*for \$380 instead of about \$150 cracked/);
});

test("cracked: trade it in as is when a repair isn't worth it", () => {
  const t = tradeIn(device(150));
  assert.equal(t.value, 60);
  assert.match(t.reason, /as is: about −\$60 with the cracked screen \(−\$150 if it weren't\)/);
});

test("not cracked: the full value", () => {
  assert.equal(tradeIn(device(380, false)).value, 380);
});

test("buying now with a cracked phone uses the lower trade-in; waiting with a repair gets the full one", () => {
  store.reset();
  callTool("add_phone_to_cart", { member: "marco", phone: "iphone-17-pro", storageGB: 256, addedBy: "marco" });
  callTool("add_phone_to_cart", { member: "maya", phone: "iphone-17", storageGB: 256, addedBy: "maya" });
  callTool("enter_evidence", { member: "marco", screenCracked: true, batteryHealth: 75, finding: "Cracked screen, Battery health 75%" });
  callTool("enter_evidence", { member: "maya", screenCracked: true, finding: "Cracked screen" });
  callTool("run_trial", {});
  const r = (id: string) => store.state.trial!.rulings.find((x) => x.memberId === id)!;
  assert.equal(r("marco").stamp, "KEEP");
  assert.equal(r("marco").tradeIn!.value, 251);
  assert.equal(r("marco").nowCost, 1099 - 251);
  assert.equal(r("maya").stamp, "WAIT");
  assert.equal(r("maya").nowCost, 129); // the repair, today
  assert.equal(r("maya").tradeIn!.value, 260);
  assert.ok(r("maya").reasons.includes("Trade in Maya's iPhone 14 once it's repaired: −$260"));
  assert.ok(!r("marco").reasons.some((x) => /Exhibit A/.test(x))); // the engine doesn't know exhibit letters
});
