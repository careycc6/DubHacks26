// Cart Court's brain: decides WHEN to speak (taste), then talks via Gemini + tools.
// Without GEMINI_API_KEY it falls back to a rules-only mode so the pipeline is testable offline.
import { GoogleGenAI, type Content, type Part } from "@google/genai";
import { hasPrefs, mergePrefs, parsePrefs, usd } from "./engine.ts";
import { state, world } from "./store.ts";
import { callTool, caseFileUrl, formatVerdict, tools } from "./tools.ts";
import { claim, introducedAs, shouldAsk, welcome, welcomeQuestion } from "./claims.ts";
import { broadcastChanges, snapshot } from "./feed.ts";

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
  setTimeout(() => broadcastChanges(before, msg.memberId, msg.spaceId).catch((e) => console.warn("[feed]", e)), 400);
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

const TRIAL_INTENT = /\b(rule|ruling|verdict|trial|check ?out|in session)\b/i;

async function reply_(msg: Incoming): Promise<string> {
  // The verdict is pure engine output: skip the LLM (instant, deterministic, costs no quota).
  if (TRIAL_INTENT.test(msg.text) && !msg.image) return rulesReply(msg);
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
        const result = callTool(c.name!, c.args ?? {});
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
  if (msg.image || (ADDRESSED.test(text) && (cracked || /battery/i.test(text)) && (cracked || batt))) {
    if (!batt && !cracked) return `🗂️ Exhibit received. Tell the court what it shows, like "cracked screen" or "battery 76%".`;
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
    const r = callTool("recommend_phones", { member: target }) as { forWhom: string; remembered: string; picks: { name: string; storageGB: number; price: number; why: string[] }[] };
    const whoFor = target === msg.memberId ? "you" : r.forWhom.split(/\s+/)[0];
    const heard = r.remembered ? `Got it: ${r.remembered}. ` : "";
    return `${heard}The court's picks for ${whoFor}:\n${r.picks.map((p, i) => `${i + 1}. ${p.name} ${p.storageGB}GB, ${usd(p.price)}: ${reasons(p.why, r.remembered)}`).join("\n")}\nSay "add the first one" to put it in the family cart.`;
  }
  // A private aside ("money's tight, don't tell the kids"): acknowledge, never repeat it.
  if (!msg.isGroup && /\b(tight|budget|afford|broke|expensive|money|bills?|don'?t tell)\b/i.test(text)) {
    return "Noted. That stays between us, and the court will keep it in mind. ⚖️";
  }
  return `⚖️ The court is listening. Try: paste a store link, "court, add the iPhone 17 Pro 256GB for me", "court, what phone should Grandma get?", or "court, rule".`;
}
