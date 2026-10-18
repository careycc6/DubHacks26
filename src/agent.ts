// Cart Court's brain: decides WHEN to speak (taste), then talks via Gemini + tools.
// Without GEMINI_API_KEY it falls back to a rules-only mode so the pipeline is testable offline.
import { GoogleGenAI, type Content, type Part } from "@google/genai";
import { accessoryType, familyBudget, findAccessory, findPhone, hasPrefs, mergePrefs, parsePrefs, recommendAccessories, usd } from "./engine.ts";
import { state, world } from "./store.ts";
import { callTool, caseFileUrl, findCartItems, formatVerdict, tools } from "./tools.ts";
import { claim, introducedAs, shouldAsk, welcome, welcomeQuestion } from "./claims.ts";
import { broadcastChanges, snapshot } from "./feed.ts";
import { later } from "./runtime.ts";

export interface Incoming {
  spaceId: string;
  isGroup: boolean;
  memberId?: string; // undefined = unknown sender
  handle?: string; // the sender's real phone number / Apple ID (Photon only)
  text: string;
  image?: { mimeType: string; base64: string };
}

const transcripts = new Map<string, string[]>();
const ADDRESSED = /\b(court|judge|cart ?court)\b/i;
const SHOPPING_INPUT = /https?:\/\//i;

const nameOf = (id?: string) => world.household.members.find((m) => m.id === id)?.name ?? "Unknown";

export function remember(spaceId: string, line: string) {
  const t = transcripts.get(spaceId) ?? [];
  t.push(line);
  if (t.length > 30) t.shift();
  transcripts.set(spaceId, t);
}

/** Taste: in a group, only speak when addressed or handed shopping material. DMs always get a reply. */
export function shouldRespond(msg: Incoming) {
  return !msg.isGroup || ADDRESSED.test(msg.text) || SHOPPING_INPUT.test(msg.text) || !!msg.image;
}

export async function handle(msg: Incoming): Promise<string | null> {
  const before = snapshot();
  const reply = await respond(msg);
  // Family feed: changes made in a 1:1 chat get a one-line update in everyone else's chat.
  // Sent just after this reply so the person who acted hears back first.
  // (Always logs to the dashboard; only 1:1 chats get relayed to the others.)
  later(() => broadcastChanges(before, msg.memberId, msg.spaceId), 400);
  return reply;
}

async function respond(msg: Incoming): Promise<string | null> {
  // Onboarding: a number the court doesn't know yet introduces itself ("I'm Maya").
  if (!msg.memberId && msg.handle) {
    const intro = introducedAs(msg.text);
    const looksLikeIntro = /^(hi|hey|hello)?[\s,!]*(i'?m|im|i am|this is|it'?s)\b/i.test(msg.text.trim()) || msg.text.trim().split(/\s+/).length <= 3;
    if (intro && looksLikeIntro) {
      claim(msg.handle, intro);
      return welcome(intro);
    }
    if (shouldAsk(msg.handle, msg.isGroup)) return welcomeQuestion();
  }
  const who = nameOf(msg.memberId);
  remember(msg.spaceId, `${who}: ${msg.text}${msg.image ? " [sent a photo]" : ""}`);
  if (!msg.isGroup && msg.memberId) {
    (state.privateNotes[msg.memberId] ??= []).push(msg.text);
  }
  if (msg.isGroup) state.groupSpaceId = msg.spaceId;
  if (msg.image) state.pendingImage = { dataUrl: `data:${msg.image.mimeType};base64,${msg.image.base64}`, private: !msg.isGroup };
  // Remember what people say they care about ("I want long battery life"), even mid-argument.
  const said = parsePrefs(msg.text.replace(URLS, " "));
  const about = mentionedMember(msg.text)?.id ?? msg.memberId;
  if (about && hasPrefs(said)) state.prefs[about] = mergePrefs(state.prefs[about], said);
  const confirmed = confirmClear(msg);
  if (confirmed) {
    remember(msg.spaceId, `Cart Court: ${confirmed}`);
    return confirmed;
  }
  if (!shouldRespond(msg)) return null;

  // "Close your tabs": store links are filed deterministically (instant, no LLM quota).
  const filed = fileLinks(msg);
  if (filed) {
    remember(msg.spaceId, `Cart Court: ${filed}`);
    return filed;
  }

  const reply = await reply_(msg);
  remember(msg.spaceId, `Cart Court: ${reply}`);
  return reply;
}

const URLS = /https?:\/\/\S+/gi;

function fileLinks(msg: Incoming): string | null {
  const urls = msg.text.match(URLS) ?? [];
  if (!urls.length) return null;
  const forWhom = mentionedMember(msg.text)?.id ?? msg.memberId;
  if (!forWhom) return null;
  const added: string[] = [];
  for (const url of urls) {
    const r = callTool("add_from_link", { url, member: forWhom }) as { added?: string; price?: number };
    if (r.added) added.push(`${r.added} (${usd(r.price ?? 0)})`);
  }
  if (!added.length) return null;
  return `📎 Filed into the family cart: ${added.join(", ")}. You can close that tab. Nobody checks out until the court rules.`;
}

const PROTECTION_ASK = /\badd (?:device |phone )?(?:protection|insurance)\b/i;
const TRIAL_INTENT = /\b(rule|ruling|verdict|trial|check ?out|in session)\b/i;
// Cart editing and purchases (deterministic: instant, no LLM needed).
// Clearing must name the cart ("cart clear", "clear the cart"), so a stray "clear" or "start over" never wipes it.
// It then asks for a YES before anything is removed.
const CLEAR_CART = /\b(clear|empty|wipe|reset)\b[^.?!]{0,20}\bcart\b|\bcart\s+(clear|empty|wipe|reset)\b/i;
const CONFIRM_YES = /^\W*(yes|yep|yeah|y|confirm|confirmed|do it)\W*$/i;
const CONFIRM_MS = 2 * 60_000;
// In a 1:1 chat, "battery health 82%" / "my battery is at 79% health" is evidence without saying "court".
const batteryReport = (msg: Incoming) => !msg.isGroup && /\bbattery\b/i.test(msg.text) && /\b\d{2,3}\s*%/.test(msg.text) && !/\b(phone|pick|recommend)s?\b.*\?/i.test(msg.text);
const REMOVE_ITEM = /\b(remove|delete|take out|scratch)\b/i; // not "drop": "when does the price drop?"
const CHANGE_ITEM = /\b(change|switch|swap|make)\b[^.?!]*\b(\d{3,4}\s*gb|to (the |a )?(iphone|pixel|galaxy))/i;
const BOUGHT = /\b(bought|purchased|ordered|picked up|just got|paid)\b/i;
// "this is for Maya" (about the purchase just logged). Not "add the case, it's for Maya".
const REASSIGN_WORDS = /\b(this|that|it)(?: one)?(?:'s|\s+is|\s+was)\s+(?:actually\s+|really\s+)?for\s+\w+/i;
const REASSIGN = { test: (t: string) => REASSIGN_WORDS.test(t) && !/\b(add|get|buy|want)\b/i.test(t) && priceIn(t) === undefined };
const PRICE =/\$\s?(\d[\d,]*(?:\.\d{1,2})?)|\b(\d[\d,]{2,}(?:\.\d{1,2})?)\s*(?:dollars|bucks|usd)\b/i;
const priceIn = (text: string) => {
  const m = text.match(PRICE);
  return m ? Number((m[1] ?? m[2]).replace(/,/g, "")) : undefined;
};

async function reply_(msg: Incoming): Promise<string> {
  // The verdict is pure engine output: skip the LLM (instant, deterministic, costs no quota).
  // Verdicts, budgets and protection are pure engine work: answer instantly, no LLM.
  if (batteryReport(msg)) return rulesReply(msg);
  const cartEdit = CLEAR_CART.test(msg.text) || (REASSIGN.test(msg.text) && state.purchases.length > 0 && !!mentionedMember(msg.text)) || REMOVE_ITEM.test(msg.text) || CHANGE_ITEM.test(msg.text) || (BOUGHT.test(msg.text) && priceIn(msg.text) !== undefined);
  if ((TRIAL_INTENT.test(msg.text) || familyBudget(msg.text) !== undefined || PROTECTION_ASK.test(msg.text) || cartEdit) && !msg.image) return rulesReply(msg);
  if (!process.env.GEMINI_API_KEY) return rulesReply(msg);
  const applied: ToolRun[] = [];
  try {
    return await llmReply(msg, applied);
  } catch (err) {
    // Rate limits / outages must never break a live demo. If tools already ran, report what they did;
    // otherwise fall back to rules-only mode.
    console.error("[llm] falling back:", (err as Error).message.slice(0, 160));
    return summarizeRuns(applied) ?? rulesReply(msg);
  }
}

type ToolRun = { name: string; result: any };

/** Show as many reasons as wishes they stated (max 2), e.g. "33h battery…; 6.9-inch screen…". */
const reasons = (why: string[], remembered: string) =>
  why.slice(0, Math.max(1, Math.min(2, remembered ? remembered.split(/, | and /).length : 1))).join("; ");

/** Plain-text summary of tool results, used when the LLM fails after acting. */
function summarizeRuns(runs: ToolRun[]): string | null {
  const lines = runs.filter((r) => !r.result?.error).map(({ name, result: r }) => {
    switch (name) {
      case "enter_evidence": {
        const u = r.updatedRuling;
        return `🗂️ ${r.exhibit} entered.` + (typeof u === "string" ? " It will count when the cart goes on trial." : ` Updated ruling: ${u.stamp}. ${u.reasons[0]}.`);
      }
      case "add_phone_to_cart": case "add_from_link": case "add_addon_to_cart": return `📥 Added: ${r.added}.`;
      case "run_trial": return r.verdictText;
      case "leaving_nest": return `🏠 ${r.stamp}: ${r.reasons.join(". ")}.`;
      case "recommend_phones": return `${r.remembered ? `Got it: ${r.remembered}. ` : ""}The court's picks:\n` + r.picks.map((x: any, i: number) => `${i + 1}. ${x.name} ${x.storageGB}GB, ${usd(x.price)}: ${reasons(x.why, r.remembered)}`).join("\n");
      case "add_recommended": return `📥 Added: ${r.added}.`;
      default: return "";
    }
  }).filter(Boolean);
  return lines.length ? lines.join("\n") : null;
}

// ---------------------------------------------------------------- LLM mode

let ai: GoogleGenAI | undefined;

// Free-tier quotas are per model (e.g. 20 requests/day), so rotate through models on 429.
// Read live so the model picker on /setup applies without a restart.
const models = () => (process.env.GEMINI_MODELS || process.env.GEMINI_MODEL || "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash")
  .split(",").map((m) => m.trim()).filter(Boolean);
const coolingUntil = new Map<string, number>();

const CALL_TIMEOUT_MS = 15_000; // one model call
const REPLY_BUDGET_MS = 30_000; // whole reply, across tool-call rounds

async function generateWithFallback(
  req: Omit<Parameters<GoogleGenAI["models"]["generateContent"]>[0], "model">,
  deadline: number,
) {
  let lastErr: unknown;
  for (const model of models()) {
    if ((coolingUntil.get(model) ?? 0) > Date.now()) continue;
    const timeLeft = deadline - Date.now();
    if (timeLeft < 2_000) break;
    try {
      const abortSignal = AbortSignal.timeout(Math.min(CALL_TIMEOUT_MS, timeLeft));
      return await ai!.models.generateContent({ ...req, model, config: { ...req.config, abortSignal } });
    } catch (err) {
      const text = String((err as Error).message ?? err);
      const slow = (err as Error).name === "TimeoutError" || (err as Error).name === "AbortError" || /abort|timed? ?out/i.test(text);
      if (/"code":\s*402|prepayment credits|billing/i.test(text)) {
        // Billing is per project, so every model is out: go straight to rules mode for a few minutes.
        for (const m of models()) coolingUntil.set(m, Date.now() + 5 * 60_000);
        console.warn("[llm] Gemini billing: prepaid credits are empty for this key's project (ai.studio/projects). Using rules mode.");
        throw err;
      } else if (slow) {
        coolingUntil.set(model, Date.now() + 30_000); // slow right now; give the next model a turn
        console.warn(`[llm] ${model} too slow; trying next model`);
      } else if (/429|RESOURCE_EXHAUSTED/.test(text)) {
        const daily = /PerDay/.test(text);
        const retry = Number(text.match(/retry in ([\d.]+)s/i)?.[1] ?? 60);
        coolingUntil.set(model, Date.now() + (daily ? Math.max(retry, 3600) : retry) * 1000);
        console.warn(`[llm] ${model} rate-limited (${daily ? "daily" : "per-minute"}); trying next model`);
      } else throw err;
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("No Gemini model available in time");
}

function systemPrompt(msg: Incoming) {
  const notes = msg.isGroup
    ? Object.entries(state.privateNotes).map(([id, n]) => `- ${nameOf(id)} told you privately: ${n.slice(-5).join(" | ")}`).join("\n")
    : (state.privateNotes[msg.memberId ?? ""] ?? []).slice(-5).map((n) => `- ${n}`).join("\n");
  return `You are Cart Court, an honest phone-shopping assistant living in a household's group chat (iMessage/SMS).
You turn the mess of links, screenshots and arguments into ONE shared cart, put the cart on trial before checkout, and often rule WAIT, because buying at the right moment is the point.

Voice: a witty but kind judge. Short texts (max ~6 lines; this is a phone). One light courtroom joke at most. No sales pressure, ever.
Plain text only: no markdown, no asterisks or bold (iMessage shows them literally). Emoji are fine.

Hard rules:
- NEVER invent prices, dates, savings, battery numbers or promos. Get every number from a tool.
- When someone wants to buy or check out, or asks you to rule, call run_trial and send its verdictText (you may add one short line before it).
- If someone wants a phone, use recommend_phones first unless they named a specific model, then add_phone_to_cart.
- Personalize: whenever someone says what they care about (battery life, a bigger or smaller screen, camera, gaming, simplicity, a price limit, a brand), call recommend_phones with those wants/brand/budget. Lead with the reason that matches what they asked for (e.g. "33h battery, among the longest here"). Preferences are remembered, so later picks keep them in mind. "Add the first one" = add_recommended with pick 1.
- If someone is moving out or leaving for college, call leaving_nest.
- Talk in plain verdicts: BUY, WAIT (and until when), SKIP. Always say how much they save.
- Accessories: for cases, screen protectors, chargers, power banks or earbuds, call recommend_accessories (it matches their phone's brand), then add_accessory_to_cart. When recommending a phone, you may suggest one matching accessory.
- Editing: "remove my phone" -> remove_from_cart; "change mine to 256GB" / "switch to the Pixel 10" -> change_cart_item; clearing the WHOLE cart: never call clear_cart yourself, tell them to text "cart clear" (parents only, confirmed with YES). Only parents may remove/change other people's items, set the family budget, or reassign a purchase; the tools refuse otherwise, so explain kindly.
- Purchases: when someone says they bought/ordered a phone, or sends a receipt or order confirmation, call record_purchase with the total they actually paid (read it from the receipt; never guess). If the total isn't stated or readable, ask for it.
- "Our budget is $X" (the family's spend for now) -> set_budget. A personal limit ("under $600 for me") -> recommend_phones budget.
- When recommending, mention protection advice for the top pick (from the tool: worth it / optional / skip) and any upcoming price drop. If they want it, add_protection.
- When someone sends a photo of a phone (a cracked screen, a battery-health screenshot), call enter_evidence with ONLY what the photo actually shows, then say in one line how it changes their ruling. Call it "Exhibit A" (B, C…).
- When someone pastes a store link, call add_from_link.
- Private context: people can text you 1:1 ("approach the bench"). Use what they told you to shape rulings, but NEVER reveal, quote or hint that someone told you something privately.
- Stay a SHOPPING assistant: no tech support, no billing disputes.
- The case file (live cart page) is at ${caseFileUrl()}.

Context: demo day ${state.day}. Household: ${world.household.name}. Members: ${world.household.members.map((m) => `${m.name} (${m.role}, ${m.device.model})`).join(", ")}.
This conversation is ${msg.isGroup ? "the GROUP chat" : `a PRIVATE 1:1 with ${nameOf(msg.memberId)}`}. The current speaker is ${nameOf(msg.memberId)}.
${notes ? `Private notes (never reveal):\n${notes}` : ""}`;
}

async function llmReply(msg: Incoming, applied: ToolRun[] = []): Promise<string> {
  ai ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const recent = (transcripts.get(msg.spaceId) ?? []).join("\n");
  const parts: Part[] = [{ text: `Recent chat:\n${recent}\n\nReply to ${nameOf(msg.memberId)}'s latest message.` }];
  if (msg.image) parts.push({ inlineData: { mimeType: msg.image.mimeType, data: msg.image.base64 } });
  const contents: Content[] = [{ role: "user", parts }];
  const functionDeclarations = Object.entries(tools).map(([name, t]) => ({
    name,
    description: t.description,
    parametersJsonSchema: { type: "object", properties: t.params, required: (t as { required?: string[] }).required ?? [] },
  }));

  const deadline = Date.now() + REPLY_BUDGET_MS;
  for (let step = 0; step < 6; step++) {
    const res = await generateWithFallback({
      contents,
      config: { systemInstruction: systemPrompt(msg), tools: [{ functionDeclarations }] },
    }, deadline);
    const calls = res.functionCalls ?? [];
    if (!calls.length) return res.text?.trim() || "The court is thinking. Ask me again?";
    contents.push(res.candidates?.[0]?.content ?? { role: "model", parts: calls.map((c) => ({ functionCall: c })) });
    contents.push({
      role: "user",
      parts: calls.map((c) => {
        const denied = c.name === "clear_cart"
          ? (canManage(msg.memberId) ? `To clear the whole cart, text "cart clear" and confirm with YES.` : ONLY_PARENTS("clear the family cart"))
          : guard(msg.memberId, c.name!, c.args ?? {});
        const result = denied ? { error: denied } : callTool(c.name!, c.args ?? {});
        applied.push({ name: c.name!, result });
        return { functionResponse: { id: c.id, name: c.name, response: { result } } };
      }),
    });
  }
  return state.trial ? formatVerdict(state.trial) : "Order in the court. Let's try that again.";
}

// ---------------------------------------------------------------- rules-only fallback

function mentionedMember(text: string) {
  const t = text.toLowerCase();
  // Full name or first name ("Jaret Zhang" or "Jaret").
  const word = (w: string) => new RegExp(`\\b${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t);
  return world.household.members.find((m) => word(m.name) || word(m.name.split(/\s+/)[0]))
    ?? (/\b(dad|my dad)\b/.test(t) ? world.household.members.find((m) => m.id === "marco") : undefined)
    ?? (/\bmom\b/.test(t) ? world.household.members.find((m) => m.id === "elena") : undefined)
    ?? (/\bgrandma\b/.test(t) ? world.household.members.find((m) => m.role === "grandparent") : undefined);
}

function rulesReply(msg: Incoming): string {
  const text = msg.text;
  const target = mentionedMember(text)?.id ?? msg.memberId ?? "marco";

  const batt = text.match(/(\d{2,3})\s*%/);
  const cracked = /\b(crack(ed)?|shattered|smashed)\b/i.test(text);
  if (msg.image || (ADDRESSED.test(text) && (cracked || /battery/i.test(text)) && (cracked || batt)) || batteryReport(msg)) {
    if (!batt && !cracked) return `🗂️ Exhibit received. Tell the court what it shows, like "cracked screen" or "battery health 76%".`;
    const finding = [cracked && "Cracked screen", batt && `Battery health ${batt[1]}%`].filter(Boolean).join(", ");
    const r = callTool("enter_evidence", { member: target, batteryHealth: batt ? Number(batt[1]) : undefined, screenCracked: cracked, finding }) as {
      exhibit: string; updatedRuling: { stamp: string; reasons: string[] } | string;
    };
    const u = r.updatedRuling;
    return `🗂️ ${r.exhibit} entered for ${nameOf(target)}: ${finding}.` + (typeof u === "string" ? "" : ` Updated ruling: ${u.stamp}. ${u.reasons[1] ?? u.reasons[0]}.`);
  }

  if (/\b(trial|verdict|rule|checkout|check out|session)\b/i.test(text)) {
    return (callTool("run_trial", {}) as { verdictText: string }).verdictText;
  }
  if (/\b(moving out|move out|college|leaving)\b/i.test(text)) {
    const n = callTool("leaving_nest", { member: target }) as { stamp: string; reasons: string[] };
    return `🏠 ${n.stamp}: ${n.reasons.join(". ")}.`;
  }
  // "add the iPhone 17 Pro 256GB for me" / "get a pixel 10 for maya 256gb"
  const add = text.match(/\b(?:add|get|buy)\s+(?:the\s+|a\s+|an\s+)?(.+?)\s+for\s+(\w+)(?:\s+(\d+)\s*gb)?\b/i);
  if (add) {
    const forWhom = /^(me|myself|mine)$/i.test(add[2]) ? (msg.memberId ?? target) : add[2];
    const gb = add[3] ?? add[1].match(/(\d{3,4})\s*(gb)?\b/i)?.[1];
    const phone = add[1].replace(/\b\d{3,4}\s*(gb)?\b/i, "").trim();
    const r = callTool("add_phone_to_cart", { member: forWhom, phone, storageGB: gb ? Number(gb) : undefined, addedBy: msg.memberId });
    return "error" in (r as object) ? `Objection: ${(r as { error: string }).error}` : `📥 Added to the family cart: ${(r as { added: string }).added}. Nobody checks out until the court rules.`;
  }
  // "add the first one" / "add #2" after a recommendation
  // ---- Editing the cart
  if (CLEAR_CART.test(text)) {
    if (!canManage(msg.memberId)) return `Objection: ${ONLY_PARENTS("clear the family cart")} You can take out your own things, like "remove my phone".`;
    if (!state.cart.length) return "The family cart is already empty.";
    (state.pendingClear ??= {})[msg.memberId!] = Date.now() + CONFIRM_MS;
    const n = state.cart.length;
    return `⚠️ This empties the whole family cart (${n} item${n === 1 ? "" : "s"}). Purchases already recorded stay. Reply YES in the next 2 minutes to clear it.`;
  }
  // A parent fixes who the last purchase was for: "this is for Maya" / "that one was for grandma"
  const forWho = REASSIGN.test(text) && state.purchases.length ? mentionedMember(text) : undefined;
  if (forWho) {
    const denied = guard(msg.memberId, "reassign_purchase", {});
    if (denied) return `Objection: ${denied}`;
    const r = callTool("reassign_purchase", { member: forWho.id }) as { recorded?: string; movedFrom?: string; tookFromCart?: string; unchanged?: boolean; error?: string };
    if (r.error) return `Objection: ${r.error}`;
    if (r.unchanged) return `🧾 Already logged for ${forWho.name}: ${r.recorded!.split(": ").slice(1).join(": ")}.`;
    return `🧾 Fixed: that purchase is ${forWho.name}'s, not ${r.movedFrom!.split(/\s+/)[0]}'s (${r.recorded!.split(": ").slice(1).join(": ")}).${r.tookFromCart ? ` Took ${r.tookFromCart} out of the cart.` : ""}`;
  }
  // "I bought my iPhone 17 Pro for $899" / "Jaret's phone was ordered, paid $629"
  const paid = priceIn(text);
  if (BOUGHT.test(text) && paid !== undefined) {
    // "bought the rugged case for $35" is an accessory; "bought my iPhone for $899" is a phone.
    const accBought = /\bin case\b/i.test(text) ? undefined : accessoryType(text);
    const named = accBought ? undefined : findPhone(world, text);
    // Whose is it? Someone named in the text; else whoever has that phone in the cart; else the sender.
    const mentioned = mentionedMember(text)?.id;
    const holders = named ? state.cart.filter((i) => i.kind === "device" && i.phoneId === named.id).map((i) => i.memberId) : [];
    const owner = mentioned ?? (holders.includes(msg.memberId ?? "") ? msg.memberId : holders[0]) ?? target;
    const matched = !mentioned && owner !== msg.memberId && holders.includes(owner);
    const r = callTool("record_purchase", { member: owner, paid, phone: named?.id, accessory: accBought ? (findAccessory(world, text)?.id ?? accBought) : undefined, fromReceipt: !!msg.image }) as {
      recorded?: string; forWhom?: string; label?: string; isPhone?: boolean; savedVsSticker?: number; vsCourtPrice?: number; budgetLeft?: number; error?: string;
    };
    if (r.error) return `Objection: ${r.error}`;
    const first = (r.forWhom ?? "").split(/\s+/)[0];
    const lines = [r.isPhone
      ? `🧾 Confirmed: this is ${first}'s new phone, ${r.label} for ${usd(paid)}.${matched ? ` (It matched the one in ${first}'s cart.)` : ""}`
      : `🧾 Recorded for ${first}: ${r.label}, ${usd(paid)}.`];
    if (r.savedVsSticker && r.savedVsSticker > 0) lines.push(`That's ${usd(r.savedVsSticker)} under sticker.`);
    if (r.vsCourtPrice !== undefined) {
      lines.push(r.vsCourtPrice <= 0 ? `Even better than the court's price. 👏` : `The court's price was ${usd(paid - r.vsCourtPrice)} (with trade-in and promos), ${usd(r.vsCourtPrice)} less.`);
    }
    if (r.budgetLeft !== undefined) lines.push(`💰 Phone budget left: ${usd(r.budgetLeft)}.`);
    if (r.isPhone) lines.push(`\nNot ${first}'s? A parent can text "this is for <name>".`);
    return lines.join(" ");
  }
  if (BOUGHT.test(text) && msg.image) return "🧾 Got the receipt. What was the total? (e.g. \"paid $899\")";
  // "switch mine to 256GB" / "change Jaret's to the pixel 10"
  if (CHANGE_ITEM.test(text)) {
    const gb = Number(text.match(/(\d{3,4})\s*gb/i)?.[1]) || undefined;
    const after = text.split(/\bto\b/i).slice(1).join(" to ");
    const newPhone = after ? findPhone(world, after)?.id : undefined;
    const denied = guard(msg.memberId, "change_cart_item", { member: target });
    if (denied) return `Objection: ${denied}`;
    const r = callTool("change_cart_item", { member: target, newPhone, storageGB: gb }) as { from?: string; to?: string; price?: number; storageNote?: string; error?: string };
    return r.error ? `Objection: ${r.error}` : `✏️ Changed ${r.from} → ${r.to} (${usd(r.price ?? 0)}).${r.storageNote ? ` ${r.storageNote}.` : ""}`;
  }
  // "remove my phone" / "take out the pixel" / "remove Jaret's protection"
  if (REMOVE_ITEM.test(text)) {
    const protection = /\b(protection|insurance)\b/i.test(text);
    const accType = accessoryType(text);
    const itemId = protection
      ? state.cart.find((i) => i.kind === "addon" && i.memberId === target && i.addonId === "protection-360")?.id
      : accType
        ? state.cart.find((i) => i.kind === "accessory" && i.memberId === target && world.catalog.accessories?.find((a) => a.id === i.accessoryId)?.type === accType)?.id
        : undefined;
    const named = protection || accType ? undefined : findPhone(world, text);
    const args = itemId ? { itemId } : { member: named ? undefined : target, phone: named?.id };
    const denied = guard(msg.memberId, "remove_from_cart", args);
    if (denied) return `Objection: ${denied}`;
    const r = callTool("remove_from_cart", args) as { removed?: string[]; error?: string };
    return r.error ? `Objection: ${r.error}` : `🗑️ Removed ${r.removed!.join(", ")} from the family cart.`;
  }

  // ---- Accessories: "what case should I get?", "add the rugged case", "any earbuds for my Pixel?"
  const accType = /\bin case\b/i.test(text) ? undefined : accessoryType(text);
  if (accType || /\baccessor(y|ies)\b/i.test(text)) {
    const named = findAccessory(world, text);
    // "add the rugged case" / "buy airpods" adds; "what case should I get?" only asks.
    if (/\b(add|buy)\b/i.test(text) && named && accType) {
      const r = callTool("add_accessory_to_cart", { member: target, accessory: named.id }) as { added?: string; price?: number; error?: string };
      return r.error ? `Objection: ${r.error}` : `📥 Added to the family cart: ${r.added} (${usd(r.price ?? 0)}).`;
    }
    const r = callTool("recommend_accessories", { member: target, type: accType }) as {
      forWhom: string; phoneBrand: string; picks: { name: string; price: number; why: string[]; shopUrl: string }[]; error?: string;
    };
    if (r.error) return `Objection: ${r.error}`;
    const whoFor = target === msg.memberId ? "your" : `${r.forWhom.split(/\s+/)[0]}'s`;
    const phoneWord = r.phoneBrand === "Apple" ? "iPhone" : r.phoneBrand === "any" ? "phone" : `${r.phoneBrand} phone`;
    return `🎧 Picks for ${whoFor} ${phoneWord}:\n${r.picks.map((p, i) => `${i + 1}. ${p.name}, ${usd(p.price)}: ${p.why[0]}\n   ${p.shopUrl}`).join("\n")}\nSay "add the first one" to put it in the family cart, or shop the link yourself and text "bought the case for $35".`;
  }

  // "Our budget is $1500"
  const fb = familyBudget(text);
  if (fb !== undefined) {
    const denied = guard(msg.memberId, "set_budget", {});
    if (denied) return `Objection: ${denied}`;
    const r = callTool("set_budget", { amount: fb }) as { planned?: number; left?: number; spent?: number; overBudget?: boolean };
    const status = r.planned === undefined
      ? "I'll fit the plan to it when the court rules."
      : r.overBudget ? `This plan (${usd(r.planned)} now and later) is still over, even with cheaper picks.`
      : `This plan uses ${usd(r.planned)} (now and later), leaving ${usd(r.left ?? 0)}.`;
    return `💰 Family phone budget set: ${usd(fb)} for the whole plan, now and later. ${status}`;
  }
  // "add protection" / "add device protection for Jaret"
  if (PROTECTION_ASK.test(text)) {
    const r = callTool("add_protection", { member: target }) as { added?: string; error?: string };
    return r.error ? `Objection: ${r.error}` : `🛡️ Added: ${r.added}.`;
  }

  const pick = text.match(/\badd (?:the )?(?:#|number )?(first|second|third|1st|2nd|3rd|1|2|3)\b/i);
  if (pick) {
    const n = { first: 1, "1st": 1, "1": 1, second: 2, "2nd": 2, "2": 2, third: 3, "3rd": 3, "3": 3 }[pick[1].toLowerCase()] ?? 1;
    const r = callTool("add_recommended", { member: target, pick: n }) as { added?: string; error?: string };
    return r.error ? `Objection: ${r.error}` : `📥 Added to the family cart: ${r.added}. Nobody checks out until the court rules.`;
  }
  // "I want a phone with long battery life" / "what phone should Grandma get?"
  const said = parsePrefs(text.replace(URLS, " "));
  const asking = /\b(recommend|suggest|which phone|what phone|should (i|we|she|he|they) get|need a (new )?phone|looking for|i want|i need|i'?d like|prefer|care about|something (with|that))\b/i;
  // Any message that says what they care about gets fresh picks ("actually I also want a bigger screen").
  if (asking.test(text) || hasPrefs(said)) {
    type Pick = { name: string; storageGB: number; price: number; why: string[]; priceDrop?: { price: number; inDays: number }; protection: { verdict: string; reason: string } };
    const r = callTool("recommend_phones", { member: target }) as { forWhom: string; remembered: string; picks: Pick[] };
    const whoFor = target === msg.memberId ? "you" : r.forWhom.split(/\s+/)[0];
    const heard = r.remembered ? `Got it: ${r.remembered}. ` : "";
    const drop = (p: Pick) => (p.priceDrop ? ` (drops to ${usd(p.priceDrop.price)} in ${p.priceDrop.inDays} days)` : "");
    const top = r.picks[0];
    const shield = top ? `\n🛡️ Protection for #1: ${top.protection.verdict === "ADD" ? "worth it. " : ""}${top.protection.reason}.` : "";
    // Accessories that fit the top pick (as if it were in the cart).
    const pairs = top
      ? recommendAccessories(world, target, { cart: [{ id: "preview", kind: "device", memberId: target, phoneId: (top as Pick & { phoneId: string }).phoneId }] })
          .slice(0, 2)
          .map((a) => `${a.name} (${usd(a.price)})`)
      : [];
    const pairLine = pairs.length ? `\n🎧 Pairs well with: ${pairs.join(", ")}. Ask "what case should I get?" for more.` : "";
    return `${heard}The court's picks for ${whoFor}:\n${r.picks.map((p, i) => `${i + 1}. ${p.name} ${p.storageGB}GB, ${usd(p.price)}${drop(p)}: ${reasons(p.why, r.remembered)}`).join("\n")}${shield}${pairLine}\nSay "add the first one" to put it in the family cart.`;
  }
  // A private aside ("money's tight, don't tell the kids"): acknowledge, never repeat it.
  if (!msg.isGroup && /\b(tight|budget|afford|broke|expensive|money|bills?|don'?t tell)\b/i.test(text)) {
    return "Noted. That stays between us, and the court will keep it in mind. ⚖️";
  }
  return [
    "⚖️ The court is listening. You can:",
    "• Paste a store link to add it to the family cart",
    "• Ask \"what phone should I get?\" (say what matters: battery, big screen, camera, budget)",
    "• Ask for a case, charger, screen protector or earbuds",
    "• Say \"remove my phone\", \"cart clear\" (parents), or \"bought it for $899\"",
    "• Say \"court, rule\" when the family is ready to check out",
  ].join("\n");
}

// ---------------------------------------------------------------- who may do what
// Without a group chat everyone talks to the court 1:1, so the court enforces the house rules itself:
// parents (and partners) run the cart; everyone else can add things and edit only their own items.
// The dashboard is always allowed (it's the admin view).

const MANAGERS = new Set(["parent", "partner"]);
const ONLY_PARENTS = (what: string) => `Only a parent can ${what}.`;

export function canManage(memberId?: string) {
  if (!memberId) return false;
  const members = world.household.members;
  // A household with no parents (roommates, a couple) runs itself: everyone may manage.
  if (!members.some((m) => MANAGERS.has(m.role))) return members.some((m) => m.id === memberId);
  return MANAGERS.has(members.find((m) => m.id === memberId)?.role ?? "");
}

/** Why this person can't run this tool, or null if they can. */
export function guard(memberId: string | undefined, name: string, args: Record<string, unknown>): string | null {
  if (canManage(memberId)) return null;
  if (name === "clear_cart") return ONLY_PARENTS("clear the family cart");
  if (name === "reassign_purchase") return ONLY_PARENTS("change who a purchase was for");
  if (name === "set_budget") return ONLY_PARENTS("set the family budget");
  if (name === "remove_from_cart" || name === "change_cart_item") {
    const hits = findCartItems(args as { member?: string; phone?: string; itemId?: string });
    if (hits.some((i) => i.memberId !== memberId)) {
      return `${ONLY_PARENTS(`${name === "remove_from_cart" ? "remove" : "change"} someone else's items`)} You can edit your own.`;
    }
  }
  return null;
}

/** A "YES" right after "cart clear" (same person, within 2 minutes) empties the cart. */
function confirmClear(msg: Incoming): string | null {
  const until = msg.memberId ? state.pendingClear?.[msg.memberId] : undefined;
  if (!until) return null;
  const no = /^\W*(no|nope|nah|cancel|stop|never ?mind|don'?t)\W*$/i.test(msg.text);
  if (!no && !CONFIRM_YES.test(msg.text)) return null;
  delete state.pendingClear![msg.memberId!];
  if (no) return "👍 Okay, the cart stays as it is.";
  if (Date.now() > until) return `That clear request timed out, so the cart is untouched. Text "cart clear" again if you still want to.`;
  if (!canManage(msg.memberId)) return `Objection: ${ONLY_PARENTS("clear the family cart")}`;
  const r = callTool("clear_cart", {}) as { cleared: number };
  return `🧹 Cart cleared (${r.cleared} item${r.cleared === 1 ? "" : "s"}). Start fresh: paste a store link or ask "court, what phone should I get?"`;
}
