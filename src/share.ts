// Getting judges in: QR codes for the case file and for texting the court.
// Only two fixed targets can be encoded, so this can't be used to make arbitrary QR codes.
import { Router, type Request } from "express";
import QRCode from "qrcode";
import { photonStatus } from "./channels/photon.ts";
import { isAdmin } from "./setup.ts";

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
