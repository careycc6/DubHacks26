// Store links (maker first, then T-Mobile, Best Buy, Amazon) and links the court can't read (it asks, never guesses).
process.env.CART_COURT_DB = "memory";
delete process.env.GEMINI_API_KEY;
import { test } from "node:test";
import assert from "node:assert/strict";

const store = await import("../src/store.ts");
const { handle } = await import("../src/agent.ts");
const { nameFromLink, shopLinks, storeName } = await import("../src/engine.ts");
const say = (memberId: string, text: string) => handle({ spaceId: `sim:${memberId}`, isGroup: false, memberId, text });

test("shop links: maker's own store first, then T-Mobile, Best Buy, Amazon", () => {
  assert.deepEqual(shopLinks("Pixel 10", ["Google"]).map((l) => l.store), ["Google Store", "T-Mobile", "Best Buy", "Amazon"]);
  assert.deepEqual(shopLinks("Power Bank", ["any"]).map((l) => l.store), ["T-Mobile", "Best Buy", "Amazon"]);
  assert.match(shopLinks("Clear Case", ["Apple"])[0].url, /apple\.com\/us\/search\/clear-case\?/);
  // Checked catalog links win, keep their price, and only stores that sell it are listed.
  const buy = [
    { store: "Amazon", url: "https://www.amazon.com/dp/X", price: 1049 },
    { store: "Dell", url: "https://www.dell.com/xps", price: 999 },
  ];
  assert.deepEqual(shopLinks("Dell XPS 13", ["Dell"], { buy }), [buy[1], buy[0]]);
});

test("a pasted link's store and name", () => {
  assert.equal(storeName("https://www.amazon.com/Levoit-Purifier-Bedroom-Filter/dp/B07VVK39F7"), "Amazon");
  assert.equal(storeName("https://amzn.to/3xYz"), "Amazon");
  assert.equal(storeName("https://www.bestbuy.com/site/x/123.p"), "Best Buy");
  assert.equal(storeName("https://shop.example.org/a"), "shop.example.org");
  assert.equal(nameFromLink("https://www.amazon.com/Levoit-Purifier-Bedroom-Filter/dp/B07VVK39F7"), "Levoit Purifier Bedroom Filter");
  assert.equal(nameFromLink("https://amzn.to/3xYz"), undefined);
});

test("a link the court can't read: it asks what it costs, then files it with their price and the link", async () => {
  store.reset();
  const url = "https://www.amazon.com/Levoit-Air-Purifier-Bedroom/dp/B07VVK39F7";
  const ask = await say("elena", url);
  assert.match(ask!, /can't read prices from Amazon yet\. Is that the Levoit Air Purifier Bedroom\? Text what it costs/);
  assert.equal(store.state.cart.length, 0); // never a guessed price
  const filed = await say("elena", "$89.99");
  assert.match(filed!, /Added to the family cart: Levoit Air Purifier Bedroom .*\$90, the price you gave/);
  const item = store.publicState().cart[0];
  assert.equal(item.url, url);
  assert.deepEqual(item.shopLinks!.map((l) => l.store), ["Amazon", "Best Buy"]);
  assert.equal(item.shopLinks![0].url, url);
  // The question is answered: a later price doesn't add anything again.
  await say("elena", "we paid $40 for the old one");
  assert.equal(store.state.cart.length, 1);
});

test("a short link with no name: it asks what it is, too", async () => {
  store.reset();
  assert.match((await say("maya", "https://amzn.to/3xYz"))!, /can't read that Amazon link yet\. What is it, and what does it cost\?/);
  assert.match((await say("maya", "a desk lamp, $35"))!, /Asked Marco and Elena to OK it: desk lamp .*\$35/);
  await say("marco", "approve");
  assert.equal(store.state.cart.at(-1)?.custom?.name, "desk lamp");
});

test("a link with its price in the same text files right away", async () => {
  store.reset();
  const r = await say("marco", "https://www.walmart.com/ip/Ninja-Professional-Blender-BL610/12345 it's $99");
  assert.match(r!, /Filed into the family cart: .*Ninja Professional Blender BL610.*\$99, the price you gave/);
});
