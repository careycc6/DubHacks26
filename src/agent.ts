// Cart Court's brain: decides WHEN to speak (taste), then talks via Gemini + tools.
// Without GEMINI_API_KEY it falls back to a rules-only mode so the pipeline is testable offline.
import { GoogleGenAI, type Content, type Part } from "@google/genai";
import { usd } from "./engine.ts";
import { state, world } from "./store.ts";
import { callTool, caseFileUrl, formatVerdict, tools } from "./tools.ts";

export interface Incoming {
  spaceId: string;
  isGroup: boolean;
  memberId?: string; // undefined = unknown sender
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
  const who = nameOf(msg.memberId);
  remember(msg.spaceId, `${who}: ${msg.text}${msg.image ? " [sent a photo]" : ""}`);
  if (!msg.isGroup && msg.memberId) {
    (state.privateNotes[msg.memberId] ??= []).push(msg.text);
  }
  if (msg.isGroup) state.groupSpaceId = msg.spaceId;
  if (msg.image) state.pendingImage = { dataUrl: `data:${msg.image.mimeType};base64,${msg.image.base64}`, private: !msg.isGroup };
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
      case "recommend_phones": return `The court's top picks:\n` + r.map((x: any, i: number) => `${i + 1}. ${x.name} ${x.storageGB}GB, ${usd(x.price)}: ${x.why[0]}`).join("\n");
      default: return "";
    }
  }).filter(Boolean);
  return lines.length ? lines.join("\n") : null;
}

// ---------------------------------------------------------------- LLM mode

let ai: GoogleGenAI | undefined;

// Free-tier quotas are per model (e.g. 20 requests/day), so rotate through models on 429.
const MODELS = (process.env.GEMINI_MODELS || process.env.GEMINI_MODEL || "gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite")
  .split(",").map((m) => m.trim()).filter(Boolean);
const coolingUntil = new Map<string, number>();

const CALL_TIMEOUT_MS = 15_000; // one model call
const REPLY_BUDGET_MS = 30_000; // whole reply, across tool-call rounds

async function generateWithFallback(
  req: Omit<Parameters<GoogleGenAI["models"]["generateContent"]>[0], "model">,
  deadline: number,
) {
  let lastErr: unknown;
  for (const model of MODELS) {
    if ((coolingUntil.get(model) ?? 0) > Date.now()) continue;
    const timeLeft = deadline - Date.now();
    if (timeLeft < 2_000) break;
    try {
      const abortSignal = AbortSignal.timeout(Math.min(CALL_TIMEOUT_MS, timeLeft));
      return await ai!.models.generateContent({ ...req, model, config: { ...req.config, abortSignal } });
    } catch (err) {
      const text = String((err as Error).message ?? err);
      const slow = (err as Error).name === "TimeoutError" || (err as Error).name === "AbortError" || /abort|timed? ?out/i.test(text);
      if (slow) {
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
  return world.household.members.find((m) => t.includes(m.name.toLowerCase()))
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
  const add = text.match(/\b(?:add|get|buy)\s+(?:the\s+)?(.+?)\s+for\s+(\w+)(?:\s+(\d+)\s*gb)?/i);
  if (add) {
    const r = callTool("add_phone_to_cart", { member: add[2], phone: add[1], storageGB: add[3] ? Number(add[3]) : undefined, addedBy: msg.memberId });
    return "error" in (r as object) ? `Objection: ${(r as { error: string }).error}` : `Added to the family cart: ${(r as { added: string }).added}. Say "court, rule" when you're ready to check out.`;
  }
  if (/\b(recommend|which phone|what phone|need a (new )?phone)\b/i.test(text)) {
    const recs = callTool("recommend_phones", { member: target }) as { name: string; storageGB: number; price: number; why: string[] }[];
    return `For ${nameOf(target)}:\n${recs.map((r, i) => `${i + 1}. ${r.name} ${r.storageGB}GB, ${usd(r.price)}: ${r.why[0]}`).join("\n")}`;
  }
  return `Cart Court here (rules-only mode). Try: "court, add 17 pro max for maya 512gb", "court, what phone for grandma", "court, rule", or "court, maya is leaving for college".`;
}
