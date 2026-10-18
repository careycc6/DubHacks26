// Merges the checked prices in .lab/prices-*.json into data/catalog.json.
// Court prices: the maker's own price; T-Mobile's only where the maker no longer sells it.
// Every store link keeps the price that store showed.
// Run: node scripts/build-catalog.mjs
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));
const catalogPath = new URL("../data/catalog.json", import.meta.url);
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
const CHECKED = "2026-10-18";
const round = (n) => Math.round(n);
const RETAIL_ORDER = ["T-Mobile", "Best Buy", "Amazon"];
const amazonSearch = (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`;
const bestBuySearch = (q) => `https://www.bestbuy.com/site/searchpage.jsp?st=${encodeURIComponent(q)}`;

/** Maker first, then T-Mobile, Best Buy, Amazon, then anything else; whole-dollar prices. */
function ordered(links) {
  const clean = links.map((l) => (l.price === undefined ? { store: l.store, url: l.url } : { store: l.store, url: l.url, price: round(l.price) }));
  const rank = (l) => (RETAIL_ORDER.includes(l.store) ? 1 + RETAIL_ORDER.indexOf(l.store) : 0);
  return clean.sort((a, b) => rank(a) - rank(b));
}

// ---- phones ----
const phoneResearch = read(".lab/prices-phones.json").phones;
const tmo = read(".lab/prices-tmobile.json");
const PHONES = {
  "iphone-17-pro-max": { prices: { 256: 1199, 512: 1399, 1024: 1599 }, note: "Apple no longer sells it (replaced by iPhone 18 Pro Max); T-Mobile still does." },
  "iphone-17-pro": { prices: { 256: 1099, 512: 1299, 1024: 1499 }, note: "Apple no longer sells it (replaced by iPhone 18 Pro); T-Mobile still does." },
  // The rest: the maker's regular unlocked price (whole dollars). A sale shows on the store link, not here,
  // so a short sale can't make a Pro cheaper than the phone it's trimmed to.
  "iphone-17": { prices: { 256: 929, 512: 1129 } },
  "iphone-17e": { prices: { 256: 699, 512: 899 } },
  "pixel-10-pro": { prices: { 128: 999, 256: 1099, 512: 1219 }, sale: 749, note: "Google has it $250 off right now ($749)." },
  "pixel-10": { prices: { 128: 799, 256: 899 } },
  "pixel-10a": { prices: { 128: 599, 256: 699 } },
  "galaxy-s26-ultra": { prices: { 256: 1400, 512: 1600, 1024: 2000 }, sale: 1200, note: "Samsung has it on sale from $1,199.99 right now." },
  "galaxy-s26": { prices: { 256: 1000, 512: 1100 }, sale: 900, note: "Samsung has it on sale from $899.99 right now." },
  "galaxy-a37": { prices: { 128: 490, 256: 610 }, name: "Galaxy A37 5G" },
  "galaxy-a17-easy": { prices: { 128: 270 }, research: "galaxy-a17" },
};
for (const p of catalog.phones) {
  const plan = PHONES[p.id];
  if (!plan) continue; // e.g. Easy Flip 5: a stand-in senior phone with no real listing
  const r = phoneResearch.find((x) => x.id === (plan.research ?? p.id));
  p.prices = plan.prices;
  if (plan.name) p.name = plan.name;
  const links = r ? [...r.buy] : [{ store: "T-Mobile", url: `https://www.t-mobile.com/cell-phone/${p.brand.toLowerCase()}-${p.id}` }];
  const tm = links.find((l) => l.store === "T-Mobile");
  if (tm && tmo.tmobilePrices[p.id]) tm.price = Math.min(...Object.values(tmo.tmobilePrices[p.id]));
  const maker = links.find((l) => !RETAIL_ORDER.includes(l.store));
  if (maker && r) maker.price = Math.min(...Object.values(r.prices));
  if (!links.some((l) => l.store === "Best Buy")) links.push({ store: "Best Buy", url: bestBuySearch(`${p.name} unlocked`) });
  if (!links.some((l) => l.store === "Amazon")) links.push({ store: "Amazon", url: amazonSearch(`${p.name} unlocked`) });
  p.buy = ordered(links);
  p.checked = CHECKED;
  const notes = [plan.note ?? r?.note].filter(Boolean);
  if (notes.length) p.priceNote = notes.join(" ");
  else delete p.priceNote;
}

// ---- add-ons ----
const ADDONS = {
  "protection-360": { name: "Protection 360", note: "T-Mobile charges $7-$26/mo by device tier; $18 is a mid tier.", url: "https://www.t-mobile.com/benefits/phone-protection-plans" },
  "hotspot-plus": { note: "Experience More includes 60GB hotspot and Beyond 250GB; this stands in for extra hotspot data.", url: "https://www.t-mobile.com/cell-phone-plans/affordable-data-plans/hotspots" },
  "intl-pass": { note: "T-Mobile's International Pass is $10/day, $50 for 10 days, $75 for 30 days.", url: "https://www.t-mobile.com/cell-phone-plans/international-roaming-plans/unlimited-calling-data-pass" },
};
for (const a of catalog.addons) {
  const plan = ADDONS[a.id];
  if (!plan) continue;
  if (plan.name) a.name = plan.name;
  a.buy = [{ store: "T-Mobile", url: plan.url }];
  a.checked = CHECKED;
  a.priceNote = plan.note;
}

// ---- products ----
const research = [...read(".lab/prices-mattress-misc.json"), ...read(".lab/prices-home.json").items];
const ALIAS = { "kitchenaid-artisan": "kitchenaid-mixer", "dyson-v15": "dyson-v15", "shark-stratos": "shark-stratos", "ninja-air-fryer": "ninja-air-fryer" };
const byId = new Map();
for (const r of research) byId.set(ALIAS[r.id] ?? r.id, r); // later files win
for (const extra of ["electronics"]) {
  const path = `.lab/prices-${extra}.json`;
  if (existsSync(new URL(`../${path}`, import.meta.url))) for (const r of read(path).items ?? read(path)) byId.set(r.id, r);
}
// T-Mobile sells more than phones: its own pages for the tablets it carries (5G models, priced in its cart),
// and its accessories store for earbuds. No price on these links: T-Mobile shows it only in the cart.
const TMOBILE = {
  "ipad-pro-11": "https://www.t-mobile.com/tablet/apple-ipad-pro-11-inch-m5",
  "ipad-11": "https://www.t-mobile.com/tablet/apple-ipad-a16",
  "galaxy-tab-s10-fe": "https://www.t-mobile.com/tablet/samsung-galaxy-tab-s10-fe-5g",
  "airpods-pro-3": "https://www.t-mobile.com/accessories",
};
const withTmobile = (id, links) => (TMOBILE[id] && !links.some((l) => l.store === "T-Mobile") ? [...links, { store: "T-Mobile", url: TMOBILE[id] }] : links);
for (const p of catalog.products) {
  const r = byId.get(p.id);
  if (!r) continue;
  const keys = Object.keys(p.prices);
  const prices = {};
  for (const [k, v] of Object.entries(r.prices)) if (v != null) prices[k] = round(v);
  // Keep the catalog's size keys when the research used the same ones; "std" stays "std".
  if (keys.every((k) => k in prices) || Object.keys(prices).length) p.prices = prices;
  p.name = r.name;
  const links = [...r.buy];
  const maker = links.find((l) => !RETAIL_ORDER.includes(l.store));
  if (maker && maker.price === undefined) maker.price = Math.min(...Object.values(prices));
  if (!links.some((l) => l.store === "Amazon")) links.push({ store: "Amazon", url: amazonSearch(r.name) });
  p.buy = ordered(withTmobile(p.id, links));
  p.checked = CHECKED;
  const notes = [r.replaces || r.replacedBy ? `Replaces ${r.replaces ?? "the older model"}.` : "", r.verified === false ? "Price from retailer listings; the brand site didn't load." : "", r.note ?? r.notes ?? ""].filter(Boolean);
  if (notes.length) p.priceNote = notes.join(" ");
}

// ---- accessories (cases, chargers, earbuds): T-Mobile's accessories store sells these too ----
const accResearch = existsSync(new URL("../.lab/prices-electronics.json", import.meta.url)) ? read(".lab/prices-electronics.json").accessories ?? [] : [];
for (const a of catalog.accessories) {
  const r = accResearch.find((x) => x.id === a.id);
  if (!r) continue;
  a.price = round(r.price);
  if (r.name) a.name = r.name;
  const links = [...r.buy];
  const maker = links.find((l) => !RETAIL_ORDER.includes(l.store));
  if (maker && maker.price === undefined) maker.price = a.price;
  if (!links.some((l) => l.store === "T-Mobile")) links.push({ store: "T-Mobile", url: "https://www.t-mobile.com/accessories" });
  if (!links.some((l) => l.store === "Amazon")) links.push({ store: "Amazon", url: amazonSearch(a.name) });
  a.buy = ordered(links);
  a.checked = CHECKED;
}

catalog._note = `Prices and store links checked ${CHECKED} on the maker's site, T-Mobile, Best Buy and Amazon (scripts/build-catalog.mjs). Prices change; each item's 'checked' date says when it was read.`;
writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
const missing = catalog.products.filter((p) => !p.buy).map((p) => p.id);
console.log(`phones ${catalog.phones.filter((p) => p.buy).length}/${catalog.phones.length}, products ${catalog.products.length - missing.length}/${catalog.products.length}, accessories ${catalog.accessories.filter((a) => a.buy).length}/${catalog.accessories.length}`);
if (missing.length) console.log("no checked price yet:", missing.join(" "));
