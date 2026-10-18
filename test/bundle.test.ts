// "add the iPhone 17 Pro with a screen protector and accessories" puts the phone and every accessory in the
// cart, and accessories show their own name and price (not "an add-on", $0).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CART_COURT_DATA_DIR = mkdtempSync(join(tmpdir(), "cart-court-test-"));
for (const k of ["MONGODB_URI", "GEMINI_API_KEY", "PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET"]) delete process.env[k];

const store = await import("../src/store.ts");
const { handle } = await import("../src/agent.ts");
const say = (text: string, memberId = "marco") => handle({ spaceId: "g", isGroup: true, memberId, text });
const cart = (who: string) => store.publicState().cart.filter((i) => i.memberId === who);

test("an accessory in the cart shows its name and price", async () => {
  store.reset();
  await say("court add a screen protector");
  const [item] = cart("marco");
  assert.equal(item.label, "Tempered Glass Screen Protector (2-pack)");
  assert.equal(item.price, 19);
});

test("a phone with a screen protector and accessories adds all of them", async () => {
  store.reset();
  const reply = (await say("court add iphone 17 pro with screen protector and accessories"))!;
  const items = cart("marco");
  assert.ok(items.some((i) => i.kind === "device" && i.phoneId === "iphone-17-pro"), reply);
  const types = items.filter((i) => i.kind === "accessory").map((i) => store.world.catalog.accessories!.find((a) => a.id === i.accessoryId)!.type);
  assert.deepEqual(types.sort(), ["case", "charger", "screen"]); // one screen protector, not two
  assert.match(reply, /iPhone 17 Pro/);
  assert.match(reply, /Screen Protector.*\$19/);
});

test("\"add accessories for Maya\" adds the essentials for her phone", async () => {
  store.reset();
  await say("court add accessories for Maya");
  assert.equal(cart("maya").filter((i) => i.kind === "accessory").length, 3);
});

test("a Pixel and a case: the case fits a Pixel", async () => {
  store.reset();
  await say("court add pixel 10 pro and a case for Elena");
  const items = cart("elena");
  assert.ok(items.some((i) => i.phoneId === "pixel-10-pro"));
  const c = store.world.catalog.accessories!.find((a) => a.id === items.find((i) => i.kind === "accessory")!.accessoryId)!;
  assert.equal(c.type, "case");
  assert.ok(c.brands.includes("Google") || c.brands.includes("any"), c.name);
});
