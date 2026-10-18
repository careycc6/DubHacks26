// Demo controls for judging rounds: checkpoints (save the court's state, put it back later) and the
// "cart filed" scene that starts a round at the trial. Nothing here texts anyone. Admin-only via the /api/demo gate.
import { Router } from "express";
import { forgetClaims } from "./claims.ts";
import { get, put } from "./db.ts";
import { logActivity, newId, reset, restoreSnapshot, snapshot, state, type Snapshot } from "./store.ts";
import { callTool } from "./tools.ts";

interface Checkpoint {
  id: string;
  name: string;
  at: number;
  snap: Snapshot;
}
const MAX_CHECKPOINTS = 10;

export const demoRouter = Router();

/** The cart the family argued about all evening (one phone each, as pasted from store links). */
export function seedCart() {
  callTool("add_phone_to_cart", { member: "maya", phone: "iphone-17-pro-max", storageGB: 512, addedBy: "maya" });
  callTool("add_phone_to_cart", { member: "marco", phone: "iphone-17-pro", storageGB: 256, addedBy: "marco" });
  callTool("add_phone_to_cart", { member: "elena", phone: "pixel-10-pro", storageGB: 256, addedBy: "elena" });
}

/** Start of a judging round: a clean court with the three links filed and Mom's private aside on record. */
export function loadPrefiledScene() {
  reset();
  forgetClaims();
  seedCart();
  state.privateNotes.elena = ["honestly money is tight this month, don't tell the kids"];
  logActivity(["🎬 Scene loaded: three phones filed, awaiting trial"]);
}

const list = () => get<Checkpoint[]>("checkpoints", []);
const summary = (c: Checkpoint) => ({
  id: c.id,
  name: c.name,
  at: c.at,
  day: c.snap.day,
  cart: c.snap.cart.length,
  ruled: !!c.snap.trial,
});

demoRouter.get("/api/demo/checkpoints", (_req, res) => res.json(list().map(summary).reverse()));

demoRouter.post("/api/demo/checkpoints", (req, res) => {
  const fallback = state.trial ? `Day ${state.day}, ruled` : `Day ${state.day}, ${state.cart.length} in the cart`;
  const name = String(req.body?.name ?? "").trim().slice(0, 60) || fallback;
  const all = [...list(), { id: newId("k"), name, at: Date.now(), snap: snapshot() }].slice(-MAX_CHECKPOINTS);
  put("checkpoints", all);
  res.json({ ok: true, checkpoint: summary(all.at(-1)!) });
});

demoRouter.post("/api/demo/checkpoints/:id/restore", (req, res) => {
  const c = list().find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ ok: false, error: "That checkpoint is gone." });
  restoreSnapshot(c.snap);
  logActivity([`⏪ Restored checkpoint "${c.name}"`]);
  res.json({ ok: true });
});

demoRouter.delete("/api/demo/checkpoints/:id", (req, res) => {
  put("checkpoints", list().filter((x) => x.id !== req.params.id));
  res.json({ ok: true });
});

demoRouter.post("/api/demo/scene/prefiled", (_req, res) => {
  loadPrefiledScene();
  res.json({ ok: true });
});
