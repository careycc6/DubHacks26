// The home dashboard (local-only, see setup.ts): who's connected, what the court decided, and a
// "Rule now" button that puts the cart on trial and texts everyone the verdict.
import { Router } from "express";
import { llmStatus } from "./agent.ts";
import { backend } from "./db.ts";
import { photonShown, photonStatus } from "./channels/photon.ts";
import { claimedHandles } from "./claims.ts";
import { savedMemberIds } from "./data.ts";
import { deliver, describeChanges, snapshot } from "./feed.ts";
import { cartLabel, priceTrack } from "./engine.ts";
import { changed, logActivity, refreshTrial, state, world } from "./store.ts";
import { callTool } from "./tools.ts";
import { wasWelcomed } from "./setup.ts";

export const dashboardRouter = Router();

type Check = { id: string; label: string; status: "ok" | "warn" | "err"; detail: string };

/** "Ready for judges?": every row comes from live state, nothing is assumed. */
function preflight(saved: string[]): Check[] {
  const checks: Check[] = [];
  checks.push(
    backend === "mongodb"
      ? { id: "db", label: "Storage", status: "ok", detail: "Saving to MongoDB" }
      : { id: "db", label: "Storage", status: "warn", detail: "Saving to files on this computer (fine on a laptop, lost on a host redeploy)" },
  );
  const photonOn = !!(process.env.PHOTON_PROJECT_ID && process.env.PHOTON_PROJECT_SECRET);
  checks.push(
    !photonOn
      ? { id: "photon", label: "iMessage", status: "warn", detail: "Photon not set up: simulator only (/sim)" }
      : photonShown() === "connected" || photonShown() === "ready"
        ? { id: "photon", label: "iMessage", status: "ok", detail: photonShown() === "ready" ? "Ready: texts arrive by webhook" : `Connected${photonStatus.line ? ` · ${photonStatus.line}` : ""}` }
        : { id: "photon", label: "iMessage", status: photonStatus.state === "error" ? "err" : "warn", detail: `Photon ${photonStatus.state}` },
  );
  checks.push(
    !process.env.GEMINI_API_KEY
      ? { id: "llm", label: "AI", status: "warn", detail: "No Gemini key: rules mode (every demo line still works)" }
      : llmStatus.billing
        ? { id: "llm", label: "AI", status: "err", detail: "Gemini billing error: replies are in rules mode (check ai.studio/projects)" }
        : llmStatus.ok === false
          ? { id: "llm", label: "AI", status: "warn", detail: "Last reply fell back to rules mode (rate limit or timeout)" }
          : { id: "llm", label: "AI", status: "ok", detail: llmStatus.ok ? `Last reply from ${llmStatus.model}` : "Key set, no replies yet" },
  );
  const url = process.env.PUBLIC_URL ?? "";
  checks.push(
    url.startsWith("https://") && !/localhost|127\.0\.0\.1/.test(url)
      ? { id: "url", label: "Public link", status: "ok", detail: url.replace(/^https:\/\//, "") }
      : { id: "url", label: "Public link", status: "warn", detail: "Case-file links won't open on phones (run npm run tunnel or set PUBLIC_URL)" },
  );
  const people = world.household.members.filter((m) => saved.includes(m.id));
  const welcomed = people.filter((m) => [...m.handles, ...claimedHandles(m.id)].some(wasWelcomed)).length;
  checks.push(
    !people.length
      ? { id: "people", label: "People", status: "warn", detail: "Still the example family (add real numbers on Setup)" }
      : { id: "people", label: "People", status: welcomed === people.length ? "ok" : "warn", detail: `${welcomed}/${people.length} welcomed` },
  );
  checks.push(
    state.trial
      ? { id: "cart", label: "Cart", status: "warn", detail: "Already ruled. Load the scene or restore a checkpoint before the next judge" }
      : { id: "cart", label: "Cart", status: "ok", detail: state.cart.length ? `${state.cart.length} filed, awaiting trial` : "Empty, ready for links" },
  );
  return checks;
}

dashboardRouter.get("/api/dashboard", (_req, res) => {
  const saved = savedMemberIds();
  res.json({
    preflight: preflight(saved),
    gemini: { configured: !!process.env.GEMINI_API_KEY, model: (process.env.GEMINI_MODELS ?? "").split(",")[0] || "gemini-3.5-flash-lite" },
    photon: { configured: !!(process.env.PHOTON_PROJECT_ID && process.env.PHOTON_PROJECT_SECRET), state: photonShown(), line: photonStatus.line ?? process.env.COURT_NUMBER ?? "" },
    publicUrl: process.env.PUBLIC_URL ?? "",
    setUp: saved.length > 0,
    budget: state.budget ?? null,
    spent: state.purchases.reduce((t, p) => t + p.paid, 0),
    planned: state.trial?.planned ?? null,
    overBudget: state.trial?.overBudget ?? false,
    // Price tracker: every phone and product in the cart, now vs the lowest price coming up (synthetic store prices).
    tracker: state.cart
      .filter((i) => (i.kind === "device" && i.phoneId) || i.kind === "product")
      .map((i) => {
        const custom = i.custom ? { price: i.custom.price, category: i.custom.category } : undefined;
        const who = world.household.members.find((m) => m.id === i.memberId);
        const t = i.kind === "device"
          ? priceTrack(world, i.phoneId!, i.storageGB ?? 128, state.day, 120, undefined, who)
          : priceTrack(world, i.productId ?? `custom:${i.id}`, i.variant ?? "std", state.day, 120, custom, who);
        return { who: who?.name ?? "", label: cartLabel(world, i), now: t.now, lowest: t.lowest, points: t.points };
      }),
    members: world.household.members
      .filter((m) => !saved.length || saved.includes(m.id))
      .map((m) => {
        const handles = [...new Set([...m.handles, ...claimedHandles(m.id)])];
        const ruling = state.trial?.rulings.find((r) => r.memberId === m.id && r.proposed?.phoneId); // their phone, not an add-on or product
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
