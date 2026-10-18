// The home dashboard (local-only, see setup.ts): who's connected, what the court decided, and a
// "Rule now" button that puts the cart on trial and texts everyone the verdict.
import { Router } from "express";
import { photonStatus } from "./channels/photon.ts";
import { claimedHandles } from "./claims.ts";
import { savedMemberIds } from "./data.ts";
import { deliver, describeChanges, snapshot } from "./feed.ts";
import { logActivity, state, world } from "./store.ts";
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
    members: world.household.members
      .filter((m) => !saved.length || saved.includes(m.id))
      .map((m) => {
        const handles = [...new Set([...m.handles, ...claimedHandles(m.id)])];
        const ruling = state.trial?.rulings.find((r) => r.memberId === m.id);
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
