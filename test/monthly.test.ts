// "≈$17/mo": the court's price spread over 24 monthly payments, next to the total.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CART_COURT_DATA_DIR = mkdtempSync(join(tmpdir(), "cart-court-test-"));
for (const k of ["MONGODB_URI", "GEMINI_API_KEY", "PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET"]) delete process.env[k];

const { perMonth } = await import("../src/engine.ts");
const { handle } = await import("../src/agent.ts");
const store = await import("../src/store.ts");
const { callTool } = await import("../src/tools.ts");

test("monthly rounds up, so the court never understates a payment", () => {
  assert.equal(perMonth(407), 17); // 16.96
  assert.equal(perMonth(408), 17);
  assert.equal(perMonth(409), 18); // 17.04
});

test("each phone in the verdict shows its monthly price; account skips don't", async () => {
  store.reset();
  callTool("add_phone_to_cart", { member: "marco", phone: "iphone-17-pro", storageGB: 256, addedBy: "marco" });
  callTool("add_phone_to_cart", { member: "elena", phone: "pixel-10-pro", storageGB: 256, addedBy: "elena" });
  const v = (await handle({ spaceId: "sim:dm:marco", isGroup: false, memberId: "marco", text: "court, rule" }))!;
  assert.match(v, /Marco · iPhone 17 Pro 256GB · \$407 on day 41 with trade-in \(\$1,099 without\) · ≈\$17\/mo/);
  assert.match(v, /Elena · Pixel 10 Pro 256GB · \$909 today with trade-in \(\$999 without\) · ≈\$38\/mo/);
  assert.doesNotMatch(v.split("\n").filter((l) => l.startsWith("✂️")).join("\n"), /\/mo/);
});
