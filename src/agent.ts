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

function remember(spaceId: string, line: string) {
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
  if (!shouldRespond(msg)) return null;

  const reply = process.env.GEMINI_API_KEY ? await llmReply(msg) : rulesReply(msg);
  remember(msg.spaceId, `Cart Court: ${reply}`);
  return reply;
}

// ---------------------------------------------------------------- LLM mode

let ai: GoogleGenAI | undefined;

function systemPrompt(msg: Incoming) {
  const notes = msg.isGroup
    ? Object.entries(state.privateNotes).map(([id, n]) => `- ${nameOf(id)} told you privately: ${n.slice(-5).join(" | ")}`).join("\n")
    : (state.privateNotes[msg.memberId ?? ""] ?? []).slice(-5).map((n) => `- ${n}`).join("\n");
  return `You are Cart Court, an honest phone-shopping assistant living in a household's group chat (iMessage/SMS).
You turn the mess of links, screenshots and arguments into ONE shared cart, put the cart on trial before checkout, and often rule WAIT, because buying at the right moment is the point.

Voice: a witty but kind judge. Short texts (max ~6 lines; this is a phone). One light courtroom joke at most. No sales pressure, ever.

Hard rules:
- NEVER invent prices, dates, savings, battery numbers or promos. Get every number from a tool.
- When someone wants to buy or check out, or asks you to rule, call run_trial and send its verdictText (you may add one short line before it).
- If someone wants a phone, use recommend_phones first unless they named a specific model, then add_phone_to_cart.
- If someone is moving out or leaving for college, call leaving_nest.
- When someone sends a photo (a cracked screen, a battery-health screenshot, a store page), describe what it shows as evidence ("Exhibit A") and use it.
- Private context: people can text you 1:1 ("approach the bench"). Use what they told you to shape rulings, but NEVER reveal, quote or hint that someone told you something privately.
- Stay a SHOPPING assistant: no tech support, no billing disputes.
- The case file (live cart page) is at ${caseFileUrl()}.

Context: demo day ${state.day}. Household: ${world.household.name}. Members: ${world.household.members.map((m) => `${m.name} (${m.role}, ${m.device.model})`).join(", ")}.
This conversation is ${msg.isGroup ? "the GROUP chat" : `a PRIVATE 1:1 with ${nameOf(msg.memberId)}`}. The current speaker is ${nameOf(msg.memberId)}.
${notes ? `Private notes (never reveal):\n${notes}` : ""}`;
}

async function llmReply(msg: Incoming): Promise<string> {
  ai ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const recent = (transcripts.get(msg.spaceId) ?? []).join("\n");
  const parts: Part[] = [{ text: `Recent chat:\n${recent}\n\nReply to ${nameOf(msg.memberId)}'s latest message.` }];
  if (msg.image) parts.push({ inlineData: { mimeType: msg.image.mimeType, data: msg.image.base64 } });
  const contents: Content[] = [{ role: "user", parts }];
  const functionDeclarations = Object.entries(tools).map(([name, t]) => ({
    name,
    description: t.description,
    parametersJsonSchema: { type: "object", properties: t.params, required: (t as { required?: string[] }).required ?? [] },
  }));

  for (let step = 0; step < 6; step++) {
    const res = await ai.models.generateContent({
      model,
      contents,
      config: { systemInstruction: systemPrompt(msg), tools: [{ functionDeclarations }] },
    });
    const calls = res.functionCalls ?? [];
    if (!calls.length) return res.text?.trim() || "The court is thinking. Ask me again?";
    contents.push(res.candidates?.[0]?.content ?? { role: "model", parts: calls.map((c) => ({ functionCall: c })) });
    contents.push({
      role: "user",
      parts: calls.map((c) => ({ functionResponse: { id: c.id, name: c.name, response: { result: callTool(c.name!, c.args ?? {}) } } })),
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
