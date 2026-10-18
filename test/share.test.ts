// The texted case-file link (/case): a link preview that says what the court decided.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CART_COURT_DATA_DIR = mkdtempSync(join(tmpdir(), "cart-court-test-"));
process.env.PUBLIC_URL = "https://court.example";
for (const k of ["MONGODB_URI", "GEMINI_API_KEY", "PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET"]) delete process.env[k];

const { caseFileHtml, caseFileUrl, preview } = await import("../src/share.ts");
const { handle } = await import("../src/agent.ts");
const store = await import("../src/store.ts");
const { callTool } = await import("../src/tools.ts");

const seed = () => {
  store.reset();
  callTool("add_phone_to_cart", { member: "maya", phone: "iphone-17-pro-max", storageGB: 512, addedBy: "maya" });
  callTool("add_phone_to_cart", { member: "marco", phone: "iphone-17-pro", storageGB: 256, addedBy: "marco" });
  callTool("add_phone_to_cart", { member: "elena", phone: "pixel-10-pro", storageGB: 256, addedBy: "elena" });
};
const rule = () => handle({ spaceId: "sim:dm:marco", isGroup: false, memberId: "marco", text: "court, rule" });

test("before a ruling the preview says what's waiting", () => {
  seed();
  assert.deepEqual(preview().title, "The Rivera household: 3 phones awaiting the court");
  assert.equal(caseFileUrl(), "https://court.example/case");
});

test("after a ruling the preview carries the verdict, and the verdict text links to it", async () => {
  seed();
  const verdict = (await rule())!;
  const p = preview();
  assert.equal(p.title, "The court saved the Rivera household $2,048");
  assert.equal(p.description, "Maya waits till day 120 · Marco waits till day 41 · Elena buys today. Spend today $3,933 → $909");
  assert.match(verdict, /Case file: https:\/\/court\.example\/case\?v=0-2048$/);
});

test("the link changes when the ruling does, so iMessage can't show a stale preview", async () => {
  seed();
  await rule();
  const before = caseFileUrl();
  await handle({ spaceId: "sim:dm:maya", isGroup: false, memberId: "maya", text: "my battery health is 76%" });
  assert.notEqual(caseFileUrl(), before);
});

test("the page keeps its tab title and gets escaped og tags with an absolute image", async () => {
  seed();
  await rule();
  const html = caseFileHtml();
  assert.match(html, /<title>Cart Court · Case File<\/title>/);
  assert.match(html, /<meta property="og:title" content="The court saved the Rivera household \$2,048" \/>/);
  assert.match(html, /<meta property="og:image" content="https:\/\/court\.example\/og-card\.png" \/>/);
  assert.match(html, /<main class="file">/); // the real page, not a stub
  seed(); // not ruled yet: the description quotes "court, rule", escaped
  assert.match(caseFileHtml(),/content="Nobody checks out until the court rules\. Text &quot;court, rule&quot;/);
});

test("prices starting with $1 stay prices in the link preview (no regex group swap)", async () => {
  seed();
  await rule();
  store.state.trial!.now = 1885; // "Spend today $3,933 → $1,885"
  const p = preview();
  const html = caseFileHtml();
  assert.ok(html.includes(`content="${p.description}"`), p.description);
  assert.ok(!/content="[^"]*<title>/.test(html));
  assert.equal((html.match(/<title>/g) ?? []).length, 1);
});
