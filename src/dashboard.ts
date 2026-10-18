// The home dashboard (local-only, see setup.ts): who's connected, what the court decided, and a
// "Rule now" button that puts the cart on trial and texts everyone the verdict.
import { Router } from "express";
import { photonStatus } from "./channels/photon.ts";
import { claimedHandles } from "./claims.ts";
import { savedMemberIds } from "./data.ts";
import { deliver, describeChanges, snapshot } from "./feed.ts";
import { priceTrack } from "./engine.ts";
import { changed, logActivity, refreshTrial, state, world } from "./store.ts";
import { callTool } from "./tools.ts";
import { wasWelcomed } from "./setup.ts";

export const dashboardRouter = Router();

dashboardRouter.get("/api/dashboard", (_req, res) => {
  const saved = savedMemberIds();
  res.json({
    gemini: { configured: !!process.env.GEMINI_API_KEY, model: (process.env.GEMINI_MODELS ?? "").split(",")[0] || "gemini-3.5-flash-lite" },
    photon: { configured: !!(process.env.PHOTON_PROJECT_ID && process.env.PHOTON_PROJECT_SECRET), state: photonStatus.state, line: photonStatus.line ?? process.env.COURT_NUMBER ?? "" },
    publicUrl: process.env.PUBLIC_URL ?? "",
    setUp: saved.length > 0,
    budget: state.budget ?? null,
    spent: state.purchases.reduce((t, p) => t + p.paid, 0),
    planned: state.trial?.planned ?? null,
    overBudget: state.trial?.overBudget ?? false,
    // Price tracker: every phone in the cart, now vs the lowest price coming up (synthetic store prices).
    tracker: state.cart
      .filter((i) => i.kind === "device" && i.phoneId)
      .map((i) => {
        const t = priceTrack(world, i.phoneId!, i.storageGB ?? 128, state.day, 120);
        const p = world.catalog.phones.find((x) => x.id === i.phoneId)!;
        return { who: world.household.members.find((m) => m.id === i.memberId)?.name ?? "", label: `${p.name} ${i.storageGB}GB`, now: t.now, lowest: t.lowest };
      }),
    members: world.household.members
      .filter((m) => !saved.length || saved.includes(m.id))
      .map((m) => {
        const handles = [...new Set([...m.handles, ...claimedHandles(m.id)])];
        const ruling = state.trial?.rulings.find((r) => r.memberId === m.id && r.proposed); // their phone, not an add-on
        return {
          id: m.id,
          name: m.name,
          role: m.role,
          phone: m.device.model,
          battery: m.device.batteryHealth,
          linked: handles.length > 0,
          welcomed: handles.some(wasWelcomed),
          ruling: ruling ? { stamp: ruling.stamp, label: ruling.proposed?.label ?? ruling.label, holdUntilDay: ruling.holdUntilDay } : undefined,
        };
      }),
  });
});

/** Set the family budget from the dashboard. */
dashboardRouter.post("/api/dashboard/budget", (req, res) => {
  const amount = Number(req.body?.amount ?? 0);
  res.json(callTool("set_budget", { amount: Number.isFinite(amount) ? amount : 0 }));
});

/** Put the cart on trial from the dashboard and text everyone the verdict. */
dashboardRouter.post("/api/dashboard/rule", async (_req, res) => {
  if (!state.cart.length) return res.json({ ok: false, error: "The cart is empty. Nothing to rule on yet." });
  const before = snapshot();
  callTool("run_trial", {});
  const lines = describeChanges(before, undefined);
  logActivity(lines);
  const told = await deliver(lines.join("\n"), undefined, "photon");
  res.json({ ok: true, told });
});

// ---- Cart editing and purchases from the dashboard. Each one is logged and texted to the family,
// exactly like the same change made by text.
async function announce(before: ReturnType<typeof snapshot>) {
  const lines = describeChanges(before, undefined);
  if (!lines.length) return 0;
  logActivity(lines);
  return deliver(lines.join("\n"), undefined, "photon");
}

dashboardRouter.post("/api/dashboard/cart/remove", async (req, res) => {
  const before = snapshot();
  const r = callTool("remove_from_cart", { itemId: String(req.body?.itemId ?? "") });
  res.json({ ...(r as object), told: await announce(before) });
});

dashboardRouter.post("/api/dashboard/cart/clear", async (_req, res) => {
  const before = snapshot();
  const r = callTool("clear_cart", {});
  res.json({ ...(r as object), told: await announce(before) });
});

dashboardRouter.post("/api/dashboard/cart/bought", async (req, res) => {
  const item = state.cart.find((i) => i.id === req.body?.itemId);
  if (!item) return res.json({ error: "That item isn't in the cart anymore." });
  const before = snapshot();
  const r = callTool("record_purchase", item.kind === "accessory"
    ? { member: item.memberId, paid: Number(req.body?.paid), itemId: item.id }
    : { member: item.memberId, paid: Number(req.body?.paid), phone: item.phoneId });
  if (!(r as { error?: string }).error) state.purchases[state.purchases.length - 1].source = "dashboard";
  res.json({ ...(r as object), told: await announce(before) });
});

/** Undo a purchase recorded by mistake (it doesn't go back into the cart; add it again if needed). */
dashboardRouter.post("/api/dashboard/purchase/undo", (req, res) => {
  const before = state.purchases.length;
  state.purchases = state.purchases.filter((p) => p.id !== req.body?.id);
  refreshTrial();
  changed();
  res.json({ removed: before - state.purchases.length });
});
