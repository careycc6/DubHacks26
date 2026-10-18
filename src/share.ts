// Getting judges in: QR codes for the case file and for texting the court, and a rich iMessage
// preview when the court texts the case-file link. Only two fixed targets can be encoded as QR codes.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Router, type Request } from "express";
import QRCode from "qrcode";
import { photonStatus } from "./channels/photon.ts";
import { usd } from "./engine.ts";
import { isAdmin } from "./setup.ts";
import { state } from "./store.ts";

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

// ---- /cart with link-preview tags, so the link the court texts unfurls with the verdict in iMessage
const cartFile = fileURLToPath(new URL("../public/cart.html", import.meta.url));
const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

shareRouter.get(["/cart", "/cart.html"], (req, res) => {
  const t = state.trial;
  const title = "The People v. The Family Cart";
  const description = t
    ? `Spend today ${usd(t.before)} → ${usd(t.now)} · saved ${usd(t.savings)}`
    : state.cart.length
      ? `${state.cart.length} phone${state.cart.length > 1 ? "s" : ""} filed · awaiting the court's ruling`
      : "Awaiting the court's ruling";
  const base = publicUrl(req);
  const tags = [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Cart Court" />`,
    `<meta property="og:title" content="${attr(title)}" />`,
    `<meta property="og:description" content="${attr(description)}" />`,
    `<meta property="og:url" content="${attr(`${base}/cart`)}" />`,
    `<meta property="og:image" content="${attr(`${base}/og.png`)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="description" content="${attr(description)}" />`,
  ].join("\n  ");
  const html = readFileSync(cartFile, "utf8").replace("</title>", `</title>\n  ${tags}`);
  res.type("html").set("Cache-Control", "no-cache").send(html);
});
