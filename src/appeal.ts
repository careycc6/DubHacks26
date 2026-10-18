// Appeals: anyone can push back on their ruling ("I appeal, I use the camera every day"), and the court
// re-hears it with the engine, never on vibes. If the argument changes the math, the appeal is granted;
// if not, the court says exactly what WOULD change it (each hint is tested against the engine first).
// A parent can overrule the court outright ("court, overrule for Maya"), and the case file records
// what that costs compared to the court's plan.
import { handMeDownText, hasPrefs, parsePrefs, runTrial, usd, whatWouldChange } from "./engine.ts";
import { callTool } from "./tools.ts";
import { changed, newId, state, trialOpts, world } from "./store.ts";
import type { Ruling } from "./types.ts";

export const APPEAL = /\b(appeal|i object|objection|reconsider|not fair|unfair)\b/i;
export const OVERRULE = /\boverrul(e|ed|ing)\b/i;
export const REINSTATE = /\breinstate\b|\bundo (the |that )?overrule\b/i;
const APPEAL_MS = 10 * 60_000;
/** "ok fine" after "tell me why": they're dropping it. */
const WITHDRAW = /^\s*(ok(ay)?|fine|k+|alright|nvm|never ?mind|forget it|whatever|nah|ugh+)\b[\s,.!]*(fine|then|whatever)?[\s.!]*$/i;

export interface AppealRecord {
  id: string;
  memberId: string;
  itemId: string;
  outcome: "GRANTED" | "PARTLY GRANTED" | "DENIED" | "OVERRULED" | "REINSTATED";
  by?: string; // the parent who overruled / reinstated
  summary: string; // one public line for the family feed and the case file
  day: number;
  at: number;
}

const nameOf = (id?: string) => world.household.members.find((m) => m.id === id)?.name ?? "Someone";
const first = (id?: string) => nameOf(id).split(/\s+/)[0];

function record(a: Omit<AppealRecord, "id" | "day" | "at">) {
  (state.appeals ??= []).push({ ...a, id: newId("ap"), day: state.day, at: Date.now() });
  if (state.appeals.length > 50) state.appeals.shift();
}

/** The phone ruling someone would appeal: theirs, and not already a plain BUY. */
function phoneRuling(memberId: string): Ruling | undefined {
  return state.trial?.rulings.find((r) => r.memberId === memberId && !!r.proposed && state.cart.some((i) => i.id === r.itemId));
}

/** A message that is still part of an appeal the court asked to hear. */
export function appealPending(memberId?: string): string | undefined {
  const p = memberId ? state.pendingAppeal?.[memberId] : undefined;
  return p && p.until > Date.now() ? p.about : undefined;
}

/** A follow-up the engine can weigh: something they want, a battery %, a cracked screen. */
export const isArgument = (text: string) => {
  const ev = evidenceIn(text);
  return hasPrefs(parsePrefs(text)) || !!ev.battery || ev.cracked;
};

/** Does this text look like an argument the engine can weigh (wants, a battery %, a cracked screen)? */
const evidenceIn = (text: string) => ({
  battery: Number(text.match(/(\d{2,3})\s*%/)?.[1]) || undefined,
  cracked: /\b(crack(ed)?|shattered|smashed)\b/i.test(text),
});

const describe = (r: Ruling) =>
  r.stamp === "WAIT" ? `WAIT till day ${r.holdUntilDay}, ${r.proposed?.label} for ${usd(r.heldCost)}`
  : `BUY the ${r.proposed?.label} for ${usd(r.nowCost)}`;

/** "I appeal …" (or the argument that follows the court's "tell me why"). */
export function appeal(text: string, senderId: string | undefined, aboutId: string | undefined, canManage: (id?: string) => boolean): string {
  const who = aboutId ?? senderId;
  if (!who) return "Tell the court who you are first (\"I'm Maya\").";
  if (!state.trial) return "There's no ruling to appeal yet. When the family is ready, say \"court, rule\".";
  const old = phoneRuling(who);
  if (!old) return `${who === senderId ? "You don't" : `${first(who)} doesn't`} have a phone ruling to appeal.${(who === senderId && elsewhere(who, canManage)) || ` Add one to the cart, then say "court, rule".`}`;
  if (old.overruled) return `A parent already overruled this one: ${first(who)} gets the ${old.proposed?.label}. Nothing left to appeal.`;
  const picked = state.cart.find((i) => i.id === old.itemId)!;
  if (old.stamp === "KEEP") return `Nothing to appeal, ${first(who)}: the court already said BUY (${old.proposed?.label}, ${usd(old.nowCost)}).${who === senderId ? elsewhere(who, canManage) : ""}`;

  const ev = evidenceIn(text);
  const argued = hasPrefs(parsePrefs(text)) || !!ev.battery || ev.cracked;
  const followUp = appealPending(senderId) === who && !APPEAL.test(text);
  if (!argued && followUp && WITHDRAW.test(text)) {
    delete state.pendingAppeal![senderId!];
    return `⚖️ Appeal withdrawn. The ruling stands: ${describe(old)}.`;
  }
  // They gave a reason, just not one that changes the price or the need ("everyone at school has one").
  const reason = text.replace(APPEAL, " ").replace(/^[\s,.:;!-]*(i|because|bc|cuz|but)?\b[\s,.:;!-]*/i, "").trim();
  if (!argued && (followUp || reason.split(/\s+/).filter((w) => w.length > 1).length >= 3)) {
    if (senderId && state.pendingAppeal) delete state.pendingAppeal[senderId];
    const hints = changers(who, old.itemId, canManage);
    record({ memberId: who, itemId: old.itemId, outcome: "DENIED", summary: `${describe(old)} stands` });
    changed();
    return [
      `⚖️ APPEAL DENIED, ${first(who)}. The court heard you, but that doesn't change the price or what the phone has to do.`,
      `The ruling stands: ${describe(old)}.`,
      hints.length ? `What would change it:\n${hints.map((h) => `• ${h}`).join("\n")}` : "",
    ].filter(Boolean).join("\n");
  }
  if (!argued) {
    (state.pendingAppeal ??= {})[senderId ?? who] = { until: Date.now() + APPEAL_MS, about: who };
    const hints = changers(who, old.itemId, canManage);
    return [
      `⚖️ The court will hear your appeal, ${first(who)}. Current ruling: ${describe(old)}.`,
      `In one text, tell me why.${hints.length ? ` What would change it:\n${hints.map((h) => `• ${h}`).join("\n")}` : ""}`,
    ].join("\n");
  }
  if (senderId && state.pendingAppeal) delete state.pendingAppeal[senderId];

  // Evidence is filed like any other exhibit (so the case file shows it). Wants were already remembered.
  if (ev.battery || ev.cracked) {
    const finding = [ev.cracked && "Cracked screen", ev.battery && `Battery health ${ev.battery}%`].filter(Boolean).join(", ");
    callTool("enter_evidence", { member: who, batteryHealth: ev.battery, screenCracked: ev.cracked, finding });
  }
  state.trial = runTrial(world, state.cart, state.day, trialOpts());
  const now = state.trial.rulings.find((r) => r.itemId === old.itemId)!;

  const unheld = old.stamp === "WAIT" && now.stamp !== "WAIT";
  const gotTheirPick = now.proposed?.phoneId === picked.phoneId && old.proposed?.phoneId !== picked.phoneId;
  const outcome: AppealRecord["outcome"] = unheld ? "GRANTED" : gotTheirPick ? (now.stamp === "WAIT" ? "PARTLY GRANTED" : "GRANTED") : "DENIED";
  const lines: string[] = [];
  if (outcome === "DENIED") {
    // The reason that actually decided it: the first one that isn't just "trade it in".
    const decisive = now.reasons.find((r) => !/^Trade in /.test(r)) ?? now.reasons[0];
    lines.push(`⚖️ APPEAL DENIED, ${first(who)}. ${decisive}.`, `The ruling stands: ${describe(now)}.`);
    const hints = changers(who, now.itemId, canManage);
    if (hints.length) lines.push(`What would change it:\n${hints.map((h) => `• ${h}`).join("\n")}`);
  } else {
    lines.push(`⚖️ APPEAL ${outcome}, ${first(who)}. The court heard you.`);
    if (gotTheirPick) {
      // Same phone, but maybe not the storage they picked: say so, with the engine's reason.
      const smaller = picked.storageGB && now.proposed!.storageGB !== picked.storageGB;
      const why = now.reasons.find((r) => /GB is (plenty|enough)|overkill/.test(r));
      lines.push(smaller ? `You keep the ${now.proposed!.label.replace(/ \d+GB$/, "")}, at ${now.proposed!.storageGB}GB.${why ? ` ${why}.` : ""}` : `You keep the ${now.proposed?.label}.`);
    }
    lines.push(now.stamp === "WAIT"
      ? `⏳ It still waits till day ${now.holdUntilDay} (${usd(now.heldCost)}): ${now.reasons.find((r) => /payments/.test(r)) ?? now.reasons.find((r) => /starts in/.test(r)) ?? now.reasons[0]}.`
      : `✅ BUY now: ${now.proposed?.label}, ${usd(now.nowCost)} today${old.stamp === "WAIT" ? ` (the old ruling: ${describe(old)})` : ""}.`);
  }
  record({ memberId: who, itemId: old.itemId, outcome, summary: outcome === "DENIED" ? `${describe(now)} stands` : describe(now) });
  changed();
  return lines.join("\n");
}

/** Nothing of yours to appeal (a 👎 on the family verdict, say): point at a ruling that's still open. */
function elsewhere(who: string, canManage: (id?: string) => boolean): string {
  const open = state.trial?.rulings.find((r) => r.memberId && r.memberId !== who && r.proposed && r.stamp !== "KEEP" && !r.overruled);
  if (!open) return "";
  const name = first(open.memberId);
  return canManage(who) ? ` To change ${name}'s: "court, overrule for ${name}". To see why: "why ${name}?"` : ` To see why ${name} waits: "why ${name}?"`;
}

/** What would change this ruling (each one tested against the engine), plus who can overrule it. */
function changers(who: string, itemId: string, canManage: (id?: string) => boolean): string[] {
  const hints = whatWouldChange(world, state.cart, itemId, state.day, trialOpts());
  if (canManage(who)) hints.push(`As a parent, you can overrule it: "court, overrule"`);
  else {
    const parents = world.household.members.filter((m) => canManage(m.id)).map((m) => first(m.id));
    if (parents.length) hints.push(`A parent can overrule: ${parents.join(" or ")} texts "court, overrule for ${first(who)}"`);
  }
  return hints;
}

/** A parent overrules the court ("court, overrule for Maya"): buy it as picked, today, with the cost on the record. */
export function overrule(senderId: string | undefined, aboutId: string | undefined, canManage: (id?: string) => boolean): string {
  if (!canManage(senderId)) return `Only a parent can overrule the court. You can appeal: text "I appeal" and tell me why.`;
  if (!state.trial) return "There's no ruling to overrule yet. Say \"court, rule\" first.";
  // Whose ruling? Someone named; else whoever appealed last; else the only phone that isn't a BUY.
  const lastAppeal = [...(state.appeals ?? [])].reverse().find((a) => a.outcome !== "OVERRULED" && a.outcome !== "REINSTATED");
  const notBuy = state.trial.rulings.filter((r) => r.proposed && r.stamp !== "KEEP" && !r.overruled);
  const who = aboutId && aboutId !== senderId ? aboutId : lastAppeal?.memberId ?? (notBuy.length === 1 ? notBuy[0].memberId : aboutId);
  if (!who) return `Whose ruling? Say "court, overrule for ${first(notBuy[0]?.memberId) || "Maya"}".`;
  const r = phoneRuling(who);
  const item = r && state.cart.find((i) => i.id === r.itemId);
  if (!r || !item) return `${first(who)} doesn't have a phone ruling to overrule.`;
  if (item.overruledBy) return `Already overruled: ${first(who)} gets the ${r.proposed?.label}. To undo it, say "court, reinstate ${first(who)}'s ruling".`;
  item.overruledBy = senderId;
  state.trial = runTrial(world, state.cart, state.day, trialOpts());
  const now = state.trial.rulings.find((x) => x.itemId === item.id)!;
  const extra = now.overruled?.extra ?? 0;
  record({ memberId: who, itemId: item.id, outcome: "OVERRULED", by: senderId, summary: `${first(senderId)} overruled the court: ${first(who)} gets the ${now.proposed?.label} today` });
  changed();
  return [
    `🔨 Overruled. ${first(who)} gets the ${now.proposed?.label} today: ${usd(now.nowCost)}${now.tradeIn ? " with trade-in" : ""}.`,
    extra > 0 ? `For the record, the court's plan was the ${now.overruled?.courtPlan}, ${usd(extra)} less. Changed your mind? "court, reinstate ${first(who)}'s ruling".` : "It costs the same as the court's plan, so no harm done.",
  ].join("\n");
}

/** Undo an overrule: the court's own ruling comes back. */
export function reinstate(senderId: string | undefined, aboutId: string | undefined, canManage: (id?: string) => boolean): string {
  if (!canManage(senderId)) return "Only a parent can change an overruled ruling.";
  const items = state.cart.filter((i) => i.overruledBy && (!aboutId || aboutId === senderId || i.memberId === aboutId));
  if (!items.length) return "Nothing is overruled right now.";
  for (const i of items) delete i.overruledBy;
  state.trial = runTrial(world, state.cart, state.day, trialOpts());
  const back = items.map((i) => state.trial!.rulings.find((r) => r.itemId === i.id)!).filter(Boolean);
  for (const r of back) record({ memberId: r.memberId!, itemId: r.itemId, outcome: "REINSTATED", by: senderId, summary: `The court's ruling is back for ${first(r.memberId)}: ${describe(r)}` });
  changed();
  return `⚖️ Reinstated. ${back.map((r) => `${first(r.memberId)}: ${describe(r)}`).join("; ")}.`;
}

export const WHY = /^\s*(why\b|how come\b|explain\b)/i;

/** "why?" (or a ❓ tapback on a verdict): the reasons behind someone's ruling, and how to push back. */
export function explain(senderId: string | undefined, aboutId: string | undefined, canManage: (id?: string) => boolean): string {
  if (!state.trial) return "The court hasn't ruled yet. When the family is ready, say \"court, rule\".";
  const who = aboutId ?? senderId;
  const r = who ? state.trial.rulings.find((x) => x.memberId === who && x.proposed) : undefined;
  if (!r) {
    const phones = state.trial.rulings.filter((x) => x.proposed && x.memberId);
    const cuts = state.trial.rulings.filter((x) => x.stamp === "CUT");
    return [
      `⚖️ ${who === senderId ? "You don't" : `${first(who)} doesn't`} have a phone in this ruling.`,
      ...cuts.map((x) => `✂️ ${x.label.replace(/^Account · /, "")}: ${x.reasons[0]}`),
      phones.length ? `Ask about someone: "why ${first(phones[0].memberId)}?"` : "",
    ].filter(Boolean).join("\n");
  }
  const verdict = r.overruled ? `OVERRULED by ${first(r.overruled.by)}: the ${r.proposed?.label} today, ${usd(r.nowCost)}`
    : r.stamp === "KEEP" ? `BUY: the ${r.proposed?.label}, ${usd(r.nowCost)} today` : describe(r);
  const mine = who === senderId;
  const push = r.overruled ? "" : r.stamp === "KEEP" ? "" : mine ? (canManage(who) ? `Disagree? You're a parent: "court, overrule" buys it anyway.` : `Disagree? Text "I appeal" and tell me why.`) : canManage(senderId) ? `Disagree? "court, overrule for ${first(who)}".` : "";
  return [
    `⚖️ Why ${mine ? "your" : `${first(who)}'s`} ruling is ${verdict}:`,
    ...r.reasons.map((x) => `• ${x}`),
    ...(r.handMeDown ? [`• ${handMeDownText(world, r)}`] : []),
    push,
  ].filter(Boolean).join("\n");
}
