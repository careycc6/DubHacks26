// Getting judges in: QR codes for the case file and for texting the court, and a rich iMessage
// preview when the court texts the case-file link (/case: the cart page plus tags that say what the court
// decided). Only two fixed targets can be encoded as QR codes.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Router, type Request } from "express";
import QRCode from "qrcode";
import { photonStatus } from "./channels/photon.ts";
import { usd } from "./engine.ts";
import { isAdmin } from "./setup.ts";
import { state, world } from "./store.ts";

export const shareRouter = Router();

export const publicUrl = (req: Request) => (process.env.PUBLIC_URL || `${req.protocol}://${req.headers.host}`).replace(/\/$/, "");
const courtNumber = () => process.env.COURT_NUMBER || photonStatus.line || "";
const FIRST_TEXT = "court, what phone should I get?";

/** Links the QR codes point at. Texting the court is admin-only: on Photon's free plan a judge's number has to be added under Users first. */
function targets(req: Request) {
  const number = courtNumber();
  return {
    cart: `${publicUrl(req)}/cart`,
    text: number && isAdmin(req) ? `sms:${number.replace(/[^\d+]/g, "")}&body=${encodeURIComponent(FIRST_TEXT)}` : undefined,
  };
}

shareRouter.get("/api/share", (req, res) => {
  const t = targets(req);
  res.json({ cartUrl: t.cart, textUrl: t.text, courtNumber: t.text ? courtNumber() : undefined, firstText: FIRST_TEXT });
});

shareRouter.get("/api/qr", async (req, res) => {
  const which = req.query.for === "text" ? "text" : "cart";
  const data = targets(req)[which];
  if (!data) return res.status(404).send("Nothing to encode (texting the court needs COURT_NUMBER and the admin view).");
  const svg = await QRCode.toString(data, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#1d1a16", light: "#fffdf8" } });
  res.type("image/svg+xml").set("Cache-Control", "no-store").send(svg);
});

let page: string | undefined; // read on first use, so a missing file can never stop the server from starting
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const base = () => process.env.PUBLIC_URL ?? "http://localhost:3000";
const household = () => world.household.name.replace(/^The /, "the "); // "saved the Rivera household"
const first = (id?: string) => (world.household.members.find((m) => m.id === id)?.name ?? "").split(/\s+/)[0];

/** The link to text. The version changes with the ruling, so iMessage doesn't show yesterday's cached preview. */
export const caseFileUrl = () => `${base()}/case${state.trial ? `?v=${state.trial.day}-${state.trial.savings}` : ""}`;

/** What the preview says: the savings and each person's ruling, or what's waiting to be ruled on. */
export function preview(): { title: string; description: string } {
  const t = state.trial;
  const n = state.cart.filter((i) => i.kind !== "addon").length;
  const allPhones = state.cart.every((i) => i.kind !== "product" && i.kind !== "accessory");
  const what = (k: number) => `${k} ${allPhones ? "phone" : "item"}${k === 1 ? "" : "s"}`;
  if (!t) {
    return {
      title: `${world.household.name}: ${n ? `${what(n)} awaiting the court` : "case file"}`,
      description: n ? `Nobody checks out until the court rules. Text "court, rule" when everyone's in.` : "Everything in the family cart, on trial. Buy now, wait, or skip, with the math.",
    };
  }
  const people = t.rulings.filter((r) => r.memberId && r.proposed).map((r) =>
    r.stamp === "WAIT" ? `${first(r.memberId)} waits till day ${r.holdUntilDay}`
    : r.stamp === "KEEP" || r.stamp === "SWAP" ? `${first(r.memberId)} buys today`
    : `${first(r.memberId)}: ${r.stamp.toLowerCase()}`);
  return {
    title: t.savings > 0 ? `The court saved ${household()} ${usd(t.savings)}` : `${world.household.name}: the court has ruled`,
    description: [people.join(" · "), `Spend today ${usd(t.before)} → ${usd(t.now)}`].filter(Boolean).join(". "),
  };
}

export function caseFileHtml() {
  const { title, description } = preview();
  const meta = [
    ["og:type", "website"], ["og:site_name", "Cart Court"], ["og:title", title], ["og:description", description],
    ["og:image", `${base()}/og-card.png`], ["og:image:width", "1200"], ["og:image:height", "630"], ["og:url", `${base()}/case`],
  ].map(([p, c]) => `  <meta property="${p}" content="${esc(c)}" />`).join("\n");
  page ??= readFileSync(fileURLToPath(new URL("../public/cart.html", import.meta.url)), "utf8");
  // A function replacer: the text holds prices like "$1,885", which a string replacement would read as "$1".
  return page.replace(/<title>[^<]*<\/title>/, (title) => `${title}\n  <meta name="description" content="${esc(description)}" />\n${meta}\n  <meta name="twitter:card" content="summary_large_image" />`);
}

// /case is the link the court texts; /cart gets the same preview when it is served by the app (locally).
shareRouter.get(["/case", "/cart", "/cart.html"], (_req, res) => {
  res.type("html").set("Cache-Control", "no-cache").send(caseFileHtml());
});
