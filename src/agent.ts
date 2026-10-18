// Cart Court's brain: decides WHEN to speak (taste), then talks via Gemini + tools.
// Without GEMINI_API_KEY it falls back to a rules-only mode so the pipeline is testable offline.
import { GoogleGenAI, type Content, type Part } from "@google/genai";
import {
  accessoryType, bestMatch, familyBudget, missingWords, modelAsked, findAccessory, findCategory, findPhone, hasPrefs, managers, memberByTitle, MANAGER_ROLES, mergePrefs, nameFromLink, parsePrefs, recommendAccessories, storeName, usd,
} from "./engine.ts";
import { actor, state, world } from "./store.ts";
import { callTool, canManage, caseFileUrl, findCartItems, formatMonthly, formatOldPhone, formatStatus, formatVerdict, tools } from "./tools.ts";
import { claim, introducedAs, shouldAsk, welcome, welcomeQuestion } from "./claims.ts";
import { broadcastChanges, snapshot } from "./feed.ts";
import { later } from "./runtime.ts";
import { APPEAL, OVERRULE, REINSTATE, WHY, appeal, appealPending, explain, isArgument, overrule, reinstate } from "./appeal.ts";

export interface Incoming {
  spaceId: string;
  isGroup: boolean;
  memberId?: string; // undefined = unknown sender
  handle?: string; // the sender's real phone number / Apple ID (Photon only)
  text: string;
  image?: { mimeType: string; base64: string };
  addressed?: boolean; // a tapback on the court's own message speaks to the court, even in a group
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
  // After a 👎 the court asked "tell me why": the answer is for the court even without "court,".
  return !msg.isGroup || !!msg.addressed || ADDRESSED.test(msg.text) || SHOPPING_INPUT.test(msg.text) || !!msg.image || continuesAppeal(msg) || answersUsage(msg);
}

export async function handle(msg: Incoming): Promise<string | null> {
  // Everything this message does runs "as" its sender: a kid's adds become requests for a parent.
  return actor.run({ memberId: msg.memberId }, () => handleAs(msg));
}

async function handleAs(msg: Incoming): Promise<string | null> {
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
  // (Phone wishes only: "a TV under $500" is not a phone budget.)
  const aboutOtherThings = !!findCategory(world, msg.text) && !/\bphones?\b/i.test(msg.text);
  if (about && hasPrefs(said) && !aboutOtherThings) state.prefs[about] = mergePrefs(state.prefs[about], said);
  const confirmed = confirmClear(msg);
  if (confirmed) {
    remember(msg.spaceId, `Cart Court: ${confirmed}`);
    return confirmed;
  }
  const linked = finishLink(msg);
  if (linked) {
    remember(msg.spaceId, `Cart Court: ${linked}`);
    return linked;
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
  const unread: string[] = [];
  let requested = false;
  for (const url of urls) {
    const r = callTool("add_from_link", { url, member: forWhom }) as { added?: string; price?: number; requested?: boolean };
    if (r.added) added.push(`${r.added} (${usd(r.price ?? 0)})`);
    else unread.push(url);
    requested ||= !!r.added && !!r.requested;
  }
  const lines: string[] = [];
  if (added.length) lines.push(requested ? addedText({ added: added.join(", "), requested }) : `📎 Filed into the family cart: ${added.join(", ")}. You can close that tab. Nobody checks out until the court rules.`);
  if (unread.length) {
    // Not in the catalog: never guess a price. Ask, and file it with their number (the link stays on the case file).
    const url = unread[0];
    const name = nameFromLink(url);
    const price = priceIn(msg.text.replace(URLS, " "));
    if (name && price) {
      const r = callTool("add_product_to_cart", { member: forWhom, product: name, price, url, addedBy: msg.memberId }) as { added?: string; error?: string; requested?: boolean };
      if (r.added) lines.push(r.requested ? addedText(r, ` (${usd(price)}, the price you gave)`) : `📎 Filed into the family cart: ${r.added} (${usd(price)}, the price you gave). Nobody checks out until the court rules.`);
    } else {
      (state.pendingLink ??= {})[msg.memberId ?? forWhom] = { url, forWhom, until: Date.now() + RECEIPT_MS, name, price };
      const store = storeName(url);
      lines.push(name
        ? `🔎 The court can't read prices from ${store} yet. Is that the ${name}? Text what it costs (like "$90") and it goes in the cart.`
        : `🔎 The court can't read that ${store} link yet. What is it, and what does it cost? (like "air purifier, $90")`);
    }
  }
  return lines.join("\n");
}

// The answer to "what does it cost?" after a link the court couldn't read: "$90", "it's a Levoit air purifier, 90 bucks".
const FILLER = /\b(it'?s|its|it|is|was|that'?s|this|the|a|an|about|like|around|costs?|for|price|yes|yeah|yep|y|ok|okay|one|bucks|dollars|usd)\b/gi;
function finishLink(msg: Incoming): string | null {
  const p = msg.memberId ? state.pendingLink?.[msg.memberId] : undefined;
  if (!p || !msg.memberId) return null;
  if (p.until < Date.now() || URLS.test(msg.text)) {
    URLS.lastIndex = 0;
    delete state.pendingLink![msg.memberId];
    return null;
  }
  const price = priceIn(msg.text) ?? (/^\W*\$?\s*\d[\d,]*(\.\d{1,2})?\W*$/.test(msg.text) ? Number(msg.text.replace(/[^\d.]/g, "")) : undefined);
  const said = msg.text.replace(PRICE, " ").replace(/\d[\d,.]*/g, " ").replace(FILLER, " ").replace(/[^\w\s'-]/g, " ").replace(/\s+/g, " ").trim();
  const name = said.split(" ").length <= 6 && /[a-z]{3}/i.test(said) && !/\?/.test(msg.text) ? said : undefined;
  if (price === undefined && !(name && p.price !== undefined && !p.name)) return null; // not an answer: carry on as usual
  const done = { ...p, price: price ?? p.price, name: name ?? p.name };
  if (!done.name) {
    state.pendingLink![msg.memberId] = done;
    return `Got it, ${usd(done.price!)}. What is it? (like "air purifier")`;
  }
  delete state.pendingLink![msg.memberId];
  const r = callTool("add_product_to_cart", { member: done.forWhom, product: done.name, price: done.price, url: done.url, addedBy: msg.memberId }) as { added?: string; error?: string };
  return addedText(r, ` (${usd(done.price!)}, the price you gave)`);
}

// "what's in the cart?", "where do we stand?", "status": answered from the cart itself, instantly.
const STATUS = /\b(what'?s|whats|what is|show( me)?|see|view|check)\b[^?.!]{0,15}\b(in )?(the |our |my )?cart\b|\bwhere do we stand\b|\bwhere are we at\b|\b(what'?s|whats|what is) the status\b|\bstatus (update|check)\b|^\W*(court,?\s*)?(status|cart)\W*$/i;
// "what do we pay a month?", "monthly", "how much per month": not "a month ago" or "one month left".
const MONTHLY = /\b(pay|paying|cost|costs|bill|total|how much)\b[^.?!]{0,25}\b(a|per|each|every) month\b|^\W*(court,?\s*)?monthly\W*$|\bmonthly (cost|total|bill|payments?)\b/i;
const OLD_PHONE = /\b(what (happens|do i do|should i do) (to|with)|who gets|trade in|keep)\b[^.?!]{0,10}\bmy (old |current )?phone\b/i;
const CHATTER = /^[\s\p{Extended_Pictographic}\p{Emoji_Modifier}‍️!?.]*(lol|lmao|haha+|omg|bruh)?[\s\p{Extended_Pictographic}\p{Emoji_Modifier}‍️!?.]*$/iu;
const PROTECTION_ASK = /\badd (?:device |phone )?(?:protection|insurance)\b/i;
const TRIAL_INTENT = /\b(rule|ruling|verdict|trial|check ?out|in session)\b/i;
// Cart editing and purchases (deterministic: instant, no LLM needed).
// Clearing must name the cart ("cart clear", "clear the cart"), so a stray "clear" or "start over" never wipes it.
// It then asks for a YES before anything is removed.
const CLEAR_CART = /\b(clear|empty|wipe|reset)\b[^.?!]{0,20}\bcart\b|\bcart\s+(clear|empty|wipe|reset)\b/i;
const CONFIRM_YES = /^\W*(yes|yep|yeah|y|confirm|confirmed|do it)\W*$/i;
const CONFIRM_MS = 2 * 60_000;
const RECEIPT_MS = 10 * 60_000;
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

/** How the last Gemini attempt went (for the dashboard's preflight panel). */
export const llmStatus: { at?: number; model?: string; ok?: boolean; billing?: boolean; error?: string } = {};

async function reply_(msg: Incoming): Promise<string> {
  // The verdict is pure engine output: skip the LLM (instant, deterministic, costs no quota).
  // Verdicts, budgets and protection are pure engine work: answer instantly, no LLM.
  if (batteryReport(msg)) return rulesReply(msg);
  if (courtroom(msg)) return rulesReply(msg);
  if (STATUS.test(msg.text) && !URLS.test(msg.text) && !msg.image) return formatStatus(msg.memberId);
  URLS.lastIndex = 0;
  if (MONTHLY.test(msg.text) && !URLS.test(msg.text) && !msg.image && !accessoryType(msg.text)) return formatMonthly();
  if (OLD_PHONE.test(msg.text) && !msg.image) return formatOldPhone(msg.memberId);
  URLS.lastIndex = 0;
  const usage = usageStep(msg);
  if (usage) return usage;
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
    const text = String((err as Error).message ?? err);
    Object.assign(llmStatus, { at: Date.now(), ok: false, model: "rules", billing: /"code":\s*402|prepayment credits|billing/i.test(text), error: text.slice(0, 160) });
    return summarizeRuns(applied) ?? rulesReply(msg);
  }
}

type ToolRun = { name: string; result: any };

// Before picking a phone, the court asks how the person actually uses one (camera and games, 1-5)
// instead of assuming. Asked once per person; the answer is remembered and used for every pick after.
const PHONE_ASK = /\b(what|which) (new )?phone\b|\b(recommend|suggest|pick)\b.*\bphone\b|\bneed a (new )?phone\b|\bphone (should|for) (i|me|we|she|he|they)\b/i;
const SKIP_USAGE = /^\s*(skip|just pick|whatever|idk|i don'?t know|no idea|doesn'?t matter|any)\b/i;
const USAGE_MS = 30 * 60_000;

/** "camera 4, games 1" / "4 and 2" / "lots of photos, no games" -> scores 1-5 (undefined if it says neither). */
export function parseUsage(text: string): { camera?: number; gaming?: number } | undefined {
  const t = text.toLowerCase();
  const word = (s: string) =>
    /\b(never|none|no|don'?t|zero|not at all)\b/.test(s) ? 1 : /\b(rarely|barely|little|a bit|sometimes)\b/.test(s) ? 2
    : /\b(some|ok|average|medium|normal)\b/.test(s) ? 3 : /\b(lots?|a lot|often|always|all the time|tons|constantly|every ?day|love)\b/.test(s) ? 5 : undefined;
  const score = (re: RegExp) => {
    const m = t.match(re);
    if (!m) return undefined;
    const n = m[0].match(/\b([1-5])\b/);
    return n ? Number(n[1]) : word(m[0]);
  };
  const out = {
    camera: score(/[^,;.]*\b(camera|photos?|pictures?|pics|selfies?|video)\b[^,;.]*/),
    gaming: score(/[^,;.]*\b(gam(e|es|ing)|play)\b[^,;.]*/),
  };
  if (out.camera === undefined && out.gaming === undefined) {
    const nums = [...t.matchAll(/\b([1-5])\b/g)].map((x) => Number(x[1]));
    if (nums.length === 2) return { camera: nums[0], gaming: nums[1] };
    return undefined;
  }
  return out;
}

const usagePending = (msg: Incoming) => {
  const p = state.pendingUsage?.[msg.memberId ?? ""];
  return p && p.until > Date.now() ? p : undefined;
};
const answersUsage = (msg: Incoming) => !!usagePending(msg) && (!!parseUsage(msg.text) || SKIP_USAGE.test(msg.text));

function phonePicksFor(msg: Incoming, target: string, text: string, lead = ""): string {
  const r = callTool("recommend_phones", { member: target, model: modelAsked(text) }) as PhonePicks;
  const you = target === msg.memberId;
  return lead + phonePicksText(r, you ? "you" : r.forWhom.split(/\s+/)[0], you ? "your" : `${r.forWhom.split(/\s+/)[0]}'s`, pairsFor(target, r.picks[0]?.phoneId));
}

/** Asks "how do you use your phone?" before the first phone picks, and turns the answer into picks. */
function usageStep(msg: Incoming): string | null {
  if (!msg.memberId || msg.image) return null;
  const text = msg.text;
  const pending = usagePending(msg);
  if (pending) {
    const said = parseUsage(text);
    if (said || SKIP_USAGE.test(text)) {
      delete state.pendingUsage![msg.memberId];
      const m = world.household.members.find((x) => x.id === pending.forWhom);
      if (!m) return null;
      const usage = { camera: said?.camera ?? m.usage.camera, gaming: said?.gaming ?? m.usage.gaming };
      (state.usage ??= {})[m.id] = usage;
      Object.assign(m.usage, usage);
      const whose = m.id === msg.memberId ? "you" : m.name.split(/\s+/)[0];
      const lead = said ? `📝 Noted: camera ${usage.camera}/5, games ${usage.gaming}/5 for ${whose}.\n\n` : "";
      return phonePicksFor(msg, m.id, "", lead);
    }
  }
  // Only a plain "what phone should I get?": a model line, a wish (battery, budget…) or another product goes on as before.
  if (!PHONE_ASK.test(text) || modelAsked(text) || hasPrefs(parsePrefs(text.replace(URLS, " "))) || (findCategory(world, text) && !/\bphones?\b/i.test(text))) return null;
  if (/\b(grandma|grandmother|abuela)\b/i.test(text) && !memberByTitle(world, text)) return null; // rulesReply says she isn't in the family
  const m = mentionedMember(text) ?? world.household.members.find((x) => x.id === msg.memberId);
  if (!m || state.usage?.[m.id]) return null;
  (state.pendingUsage ??= {})[msg.memberId] = { forWhom: m.id, until: Date.now() + USAGE_MS };
  const you = m.id === msg.memberId;
  const first = m.name.split(/\s+/)[0];
  return `⚖️ Before the court picks${you ? "" : ` for ${first}`}: on a scale of 1 to 5, how much ${you ? "do you" : `does ${first}`} use the camera, and how much ${you ? "do you" : "do they"} play games?\nReply like "camera 4, games 1" (or "skip" and the court will go by ${you ? "your" : `${first}'s`} current phone).`;
}

/** Show as many reasons as wishes they stated (max 2), e.g. "33h battery…; 6.9-inch screen…". */
const reasons = (why: string[], remembered: string) =>
  why.slice(0, Math.max(1, Math.min(2, remembered ? remembered.split(/, | and /).length : 1))).join("; ");

type PhonePick = {
  phoneId: string; name: string; storageGB: number; price: number; why: string[];
  priceDrop?: { price: number; inDays: number }; protection: { verdict: string; reason: string };
  withTradeIn?: { price: number; tradeIn: string }; stores?: { store: string; url: string; price?: number }[];
  carrierDeal?: { store: string; value: number; needs: string; plans: string; url: string };
};
type PhonePicks = { forWhom: string; remembered: string; modelNote?: string; others?: { name: string; storageGB: number; price: number }[]; tradeIn?: { device: string; value: number; where: string }; picks: PhonePick[] };

/** Accessories that fit a phone (as if it were already in their cart), for "Pairs well with". */
function pairsFor(memberId: string, phoneId?: string): string[] {
  if (!phoneId) return [];
  return recommendAccessories(world, memberId, { cart: [{ id: "preview", kind: "device", memberId, phoneId }] })
    .slice(0, 2)
    .map((a) => `${a.name} (${usd(a.price)})`);
}

/** The court's phone picks: price at T-Mobile, what's traded in and where, the carrier deal, and every store for #1. */
function phonePicksText(r: PhonePicks, who: string, whose: string, pairs: string[] = []): string {
  const top = r.picks[0];
  const tmo = (p: PhonePick) => p.stores?.find((l) => l.store === "T-Mobile" && l.price !== undefined && Math.round(l.price) === Math.round(p.price));
  const line = (p: PhonePick, i: number) =>
    `${i + 1}. ${p.name} ${p.storageGB}GB, ${usd(p.price)}${tmo(p) ? " at T-Mobile" : ""}` +
    (p.withTradeIn ? ` (${usd(p.withTradeIn.price)} after trading in ${whose} ${p.withTradeIn.tradeIn})` : "") +
    (p.priceDrop ? ` (drops to ${usd(p.priceDrop.price)} in ${p.priceDrop.inDays} days)` : "") +
    `: ${reasons(p.why, r.remembered)}`;
  const out = [`${r.remembered ? `Got it: ${r.remembered}. ` : ""}The court's picks for ${who}:`];
  if (r.modelNote) out.push(r.modelNote);
  out.push(...r.picks.map(line));
  if (r.others?.length) out.push(`Other ideas: ${r.others.map((o, i) => `${r.picks.length + i + 1}. ${o.name} ${o.storageGB}GB, ${usd(o.price)}`).join(" · ")}`);
  if (r.tradeIn) out.push(`♻️ Trade-in: ${whose} ${r.tradeIn.device}, worth about ${usd(r.tradeIn.value)} at ${r.tradeIn.where}.`);
  const deal = top?.carrierDeal;
  if (deal) out.push(`📣 ${deal.store} deal on #1: up to ${usd(deal.value)} off ${deal.needs} on ${deal.plans}, paid as monthly bill credits. ${deal.url}`);
  if (top?.stores?.length) {
    out.push(`🛒 Where to buy #1:\n${top.stores.map((l) => `   ${l.store}${l.price !== undefined ? ` ${usd(l.price)}` : ""}: ${l.url}`).join("\n")}`);
  }
  if (top) out.push(`🛡️ Protection for #1: ${top.protection.verdict === "ADD" ? "worth it. " : ""}${top.protection.reason}.`);
  if (pairs.length) out.push(`🎧 Pairs well with: ${pairs.join(", ")}. Ask "what case should I get?" for more.`);
  out.push(`Say "add the first one" (or any number) to put it in the family cart.`);
  return out.join("\n");
}

/** Plain-text summary of tool results, used when the LLM fails after acting. */
function summarizeRuns(runs: ToolRun[]): string | null {
  const lines = runs.filter((r) => !r.result?.error).map(({ name, result: r }) => {
    switch (name) {
      case "enter_evidence": {
        const u = r.updatedRuling;
        return `🗂️ ${r.exhibit} entered.` + (typeof u === "string" ? " It will count when the cart goes on trial." : ` Updated ruling: ${u.stamp}. ${u.reasons[0]}.`);
      }
      case "add_phone_to_cart": case "add_product_to_cart": case "add_from_link": case "add_addon_to_cart": case "add_accessory_to_cart": return addedText(r, "", "");
      case "approve_request": return r.error ? "" : `✅ Approved: ${r.approved.join(", ")}. It's in the family cart.`;
      case "deny_request": return r.error ? "" : `🚫 Not this time: ${r.denied.join(", ")}.`;
      case "recommend_products": return `The court's ${r.category} picks:\n` + r.picks.map((x: any, i: number) => `${i + 1}. ${x.name}, ${usd(x.price)}: ${x.why.slice(0, 2).join("; ")}`).join("\n");
      case "report_owned_item": return `🗂️ Noted: ${r.owned.name}${r.owned.broken ? " (broken)" : ""}.` + (typeof r.updatedRuling === "string" ? "" : ` Updated ruling: ${r.updatedRuling.stamp}.`);
      case "run_trial": return r.verdictText;
      case "leaving_nest": return `🏠 ${r.stamp}: ${r.reasons.join(". ")}.`;
      case "recommend_phones": return phonePicksText(r, r.forWhom.split(/\s+/)[0], `${r.forWhom.split(/\s+/)[0]}'s`);
      case "add_recommended": return addedText(r, "", "");
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
      const res = await ai!.models.generateContent({ ...req, model, config: { ...req.config, abortSignal } });
      Object.assign(llmStatus, { at: Date.now(), ok: true, model, billing: false, error: undefined });
      return res;
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
  return `You are Cart Court, an honest shopping assistant living in a household's group chat (iMessage/SMS). You handle anything a family buys: phones, laptops, TVs, headphones, game consoles, appliances, furniture, mattresses, shoes, clothes, and things the store doesn't carry.
You turn the mess of links, screenshots and arguments into ONE shared cart, put the cart on trial before checkout, and often rule WAIT, because buying at the right moment is the point.

Voice: a witty but kind judge. Short texts (max ~6 lines; this is a phone). One light courtroom joke at most. No sales pressure, ever.
Plain text only: no markdown, no asterisks or bold (iMessage shows them literally). Emoji are fine.

Hard rules:
- NEVER invent prices, dates, savings, battery numbers or promos. Get every number from a tool.
- When someone wants to buy or check out, or asks you to rule, call run_trial and send its verdictText (you may add one short line before it).
- If someone wants a phone, use recommend_phones first unless they named a specific model, then add_phone_to_cart.
- Anything else (a laptop, TV, vacuum, chair, jacket…): recommend_products for the category unless they named a specific product, then add_product_to_cart. If the store doesn't carry it, add it as a custom item with the price THEY gave; if they gave no price, ask for it.
- When someone says something about a thing they already own ("the vacuum died", "our TV is fine"), call report_owned_item. Broken means buy now; a working one that's still young can wait.
- Personalize: whenever someone says what they care about (battery life, a bigger or smaller screen, camera, gaming, simplicity, a price limit, a brand), call recommend_phones with those wants/brand/budget. Lead with the reason that matches what they asked for (e.g. "33h battery, among the longest here"). Preferences are remembered, so later picks keep them in mind. "Add the first one" = add_recommended with pick 1.
- If someone is moving out or leaving for college, call leaving_nest.
- Talk in plain verdicts: BUY, WAIT (and until when), SKIP. Always say how much they save.
- Accessories: for cases, screen protectors, chargers, power banks or earbuds, call recommend_accessories (it matches their phone's brand), then add_accessory_to_cart. When recommending a phone, you may suggest one matching accessory.
- Editing: "remove my phone" -> remove_from_cart; "change mine to 256GB" / "switch to the Pixel 10" -> change_cart_item; clearing the WHOLE cart: never call clear_cart yourself, tell them to text "cart clear" (parents only, confirmed with YES). Only parents may remove or change cart items, set the family budget, or reassign a purchase; the tools refuse otherwise, so explain kindly (a kid who bought something says "bought it for $X" and it comes off the cart).
- Kids' adds become requests (the add tools return requested: true): tell them a parent has to OK it. A parent says "approve" / "approve Jaret's" / "deny" -> approve_request / deny_request.
- Never add a phone that isn't exactly what they named ("iphone 18" when there's an 18 Pro and an 18 Pro Max): call recommend_phones with model and let them pick.
- Purchases: when someone says they bought/ordered a phone, or sends a receipt or order confirmation, call record_purchase with the total they actually paid (read it from the receipt; never guess). If the total isn't stated or readable, ask for it. Kids can log their own purchases; logging one as someone else's needs a receipt photo (the tool refuses otherwise).
- "Our budget is $X" (the family's spend for now) -> set_budget. A personal limit ("under $600 for me") -> recommend_phones budget.
- When recommending, mention protection advice for the top pick (from the tool: worth it / optional / skip) and any upcoming price drop. If they want it, add_protection.
- When someone sends a photo of a phone (a cracked screen, a battery-health screenshot), call enter_evidence with ONLY what the photo actually shows, then say in one line how it changes their ruling. Call it "Exhibit A" (B, C…).
- When someone pastes a store link (any product), call add_from_link.
- Private context: people can text you 1:1 ("approach the bench"). Use what they told you to shape rulings, but NEVER reveal, quote or hint that someone told you something privately.
- Stay a SHOPPING assistant: no tech support, no billing disputes.
- The case file (live cart page) is at ${caseFileUrl()}.

Context: demo day ${state.day}. Household: ${world.household.name}. Members: ${world.household.members.map((m) => `${m.name} (${m.role}, ${m.device.model})`).join(", ")}.
Already owned: ${(world.household.owned ?? []).map((o) => `${o.name}${o.memberId ? ` (${nameOf(o.memberId)})` : ""}, ${o.ageMonths} mo${o.broken ? ", broken" : ""}`).join("; ") || "nothing on file"}.
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
          : guard(msg.memberId, c.name!, c.args ?? {}, { image: !!msg.image });
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
    ?? memberByTitle(world, t);
}

/** Appeals, overrules, reinstatements and "why?" are engine work: always deterministic, even with Gemini on. */
function courtroom(msg: Incoming) {
  if (!state.trial) return false;
  if (OVERRULE.test(msg.text) || REINSTATE.test(msg.text) || APPEAL.test(msg.text)) return true;
  // "why?" / "why Maya?" explains a ruling; "why should I get a case?" is a shopping question.
  if (WHY.test(msg.text) && !msg.image && msg.text.trim().split(/\s+/).length <= 6 && !/\b(should|which|what|best|good|get|buy)\b/i.test(msg.text) && !accessoryType(msg.text)) {
    const rest = msg.text.replace(WHY, "").replace(/[?!.\s]+/g, " ").trim();
    if (!rest || mentionedMember(rest) || /\b(ruling|verdict|court|wait|skip|that|this|it|not|me|mine|my|phone|iphone|pixel|galaxy|pro|max|day)\b/i.test(rest)) return true;
  }
  if (!appealPending(msg.memberId)) return false;
  if (CHATTER.test(msg.text) && !msg.image) return false; // "lol" isn't the argument, and doesn't drop it either
  const continues = continuesAppeal(msg);
  if (!continues && !msg.image) delete state.pendingAppeal![msg.memberId!];
  return continues;
}

/** With an appeal open, the next statement is their argument (even a weak one, which gets a real
 *  answer); a question ("what case should I get?"), a link, a purchase or a command moves on.
 *  "court, everyone has one" is still the argument: only the address is stripped. */
function continuesAppeal(msg: Incoming) {
  if (!appealPending(msg.memberId) || CHATTER.test(msg.text)) return false;
  const text = msg.text.replace(/^\s*(court|judge|cart ?court)\b[\s,:]*/i, "");
  const question = /\?\s*$/.test(text) || /^\s*(what|which|how|can|could|should|is|are|do|does|when|where|who)\b/i.test(text);
  const command = TRIAL_INTENT.test(text) || STATUS.test(text) || MONTHLY.test(text) || REMOVE_ITEM.test(text) || CLEAR_CART.test(text);
  const continues = (isArgument(text) || (!question && !command)) && !URLS.test(text) && !BOUGHT.test(text) && !accessoryType(text);
  URLS.lastIndex = 0;
  return continues;
}

function rulesReply(msg: Incoming): string {
  const text = msg.text;
  const target = mentionedMember(text)?.id ?? msg.memberId ?? managers(world)[0]?.id ?? world.household.members[0]?.id;
  if (!target) return "⚖️ The court doesn't know anyone in this household yet. Add the family on /setup first.";
  if (courtroom(msg)) {
    const about = mentionedMember(text)?.id;
    if (REINSTATE.test(text)) return reinstate(msg.memberId, about, canManage);
    if (OVERRULE.test(text)) return overrule(msg.memberId, about, canManage);
    if (WHY.test(text) && !APPEAL.test(text)) return explain(msg.memberId, about, canManage);
    return appeal(text, msg.memberId, about ?? appealPending(msg.memberId), canManage);
  }

  const batt = text.match(/(\d{2,3})\s*%/);
  const cracked = /\b(crack(ed)?|shattered|smashed)\b/i.test(text);
  const receiptFollowUp = !!msg.image && (state.pendingReceipt?.[msg.memberId ?? ""]?.until ?? 0) > Date.now();
  if (!BOUGHT.test(text) && !receiptFollowUp && (msg.image || (ADDRESSED.test(text) && (cracked || /battery/i.test(text)) && (cracked || batt)) || batteryReport(msg))) {
    if (!batt && !cracked) return `🗂️ Exhibit received. Tell the court what it shows, like "cracked screen" or "battery health 76%".`;
    const finding = [cracked && "Cracked screen", batt && `Battery health ${batt[1]}%`].filter(Boolean).join(", ");
    const r = callTool("enter_evidence", { member: target, batteryHealth: batt ? Number(batt[1]) : undefined, screenCracked: cracked, finding }) as {
      exhibit: string; updatedRuling: { stamp: string; reasons: string[] } | string;
    };
    const u = r.updatedRuling;
    return `🗂️ ${r.exhibit} entered for ${nameOf(target)}: ${finding}.` + (typeof u === "string" ? "" : ` Updated ruling: ${u.stamp}. ${u.reasons[1] ?? u.reasons[0]}.`);
  }
  // "my screen is cracked" in a DM: say what the court needs, rather than the menu.
  if (!msg.isGroup && cracked && !BOUGHT.test(text)) {
    return `📸 The court needs to see it. Send a photo of the screen with "cracked screen" as the caption, and it goes into evidence.`;
  }

  // "the vacuum died" / "my laptop is broken" / "our TV still works fine"
  const ownedCat = findCategory(world, text);
  const broke = /\b(died|dead|broke|broken|stopped working|doesn'?t work|won'?t turn on)\b/i.test(text);
  const fine = /\b(still works|works fine|works great|is fine)\b/i.test(text);
  if (ownedCat && (broke || fine) && !/\b(add|get|buy)\b/i.test(text)) {
    const mine = /\b(my|mine)\b/i.test(text);
    const r = callTool("report_owned_item", { member: mine ? target : undefined, category: ownedCat, broken: broke }) as {
      owned?: { name: string }; updatedRuling?: { stamp: string; reasons: string[] } | string; error?: string;
    };
    if (r.error) return `Objection: ${r.error}`;
    const u = r.updatedRuling;
    return `🗂️ Noted for the record: the ${r.owned!.name} ${broke ? "is broken. Replacing it can't wait" : "still works. No rush"}.` +
      (u && typeof u !== "string" ? ` Updated ruling: ${u.stamp}. ${u.reasons[0]}.` : "");
  }

  if (/\b(trial|verdict|rule|checkout|check out|session)\b/i.test(text)) {
    return (callTool("run_trial", {}) as { verdictText: string }).verdictText;
  }
  if (/\b(moving out|move out|college|leaving)\b/i.test(text)) {
    const n = callTool("leaving_nest", { member: target }) as { stamp: string; reasons: string[] };
    return `🏠 ${n.stamp}: ${n.reasons.join(". ")}.`;
  }
  // A parent answers a kid's request: "approve", "approve Jaret's", "approve all", "deny".
  const verdictOnAsk = (state.requests?.length ?? 0) > 0 && text.match(/^\W*(?:(?:court|judge)[\s,:]+)?(approve|approved|ok(?:ay)? it|yes,? add it|deny|denied|reject|decline|no to)\b(.*)$/i);
  if (verdictOnAsk) {
    const yes = !/^(deny|denied|reject|decline|no to)$/i.test(verdictOnAsk[1]);
    const denied = guard(msg.memberId, yes ? "approve_request" : "deny_request", {});
    if (denied) return `Objection: ${denied}`;
    const who = mentionedMember(verdictOnAsk[2])?.id;
    const r = callTool(yes ? "approve_request" : "deny_request", { member: who, all: /\b(all|both|everything)\b/i.test(verdictOnAsk[2]) }) as { approved?: string[]; denied?: string[]; error?: string; waiting?: string[] };
    if (r.error) return r.waiting ? `${r.error} Say whose: ${r.waiting.join(" · ")} (e.g. "approve Jaret's", or "approve all").` : r.error;
    return yes ? `✅ Approved: ${r.approved!.join(", ")}. It's in the family cart. Say "court, rule" when everyone's in.` : `🚫 Not this time: ${r.denied!.join(", ")}.`;
  }
  // "add the iPhone 17 Pro 256GB for me" / "get a pixel 10 for maya 256gb"
  // "add an iPhone 18" / "buy me the pixel 10 256gb": no "for", so it's for whoever's named, else the sender.
  // Only when it names a phone or product; "add the first one", "add protection" and "add a case" are handled below.
  const bare = text.match(/\b(?:add|buy|get me)\s+(?:me\s+)?(?:the\s+|a\s+|an\s+)?(.+?)(?:\s+(?:to|in)\s+(?:the\s+|our\s+|my\s+)?(?:family\s+)?cart)?\s*[.!]*$/i);
  const bareItem = bare?.[1].replace(/\s+for\s+.*$/i, "").trim();
  const bareAdd = bare && !/\sfor\s/i.test(bare[1]) && !PROTECTION_ASK.test(text) && !accessoryType(bareItem!) && !/\?/.test(text) &&
    !/^(?:#|number )?(first|second|third|1st|2nd|3rd|[123])\b/i.test(bareItem!) &&
    (bestMatch(world.catalog.phones, bareItem!) || bestMatch(world.catalog.products ?? [], bareItem!))
    ? ([bare[0], bareItem!, "me", undefined] as unknown as RegExpMatchArray)
    : undefined;
  const add = text.match(/\b(?:add|get|buy)\s+(?:the\s+|a\s+|an\s+)?(.+?)\s+for\s+(\w+)(?:\s+(\d+)\s*gb)?\b/i) ?? bareAdd;
  if (add) {
    // "for kairui cheng": prefer a whole name typed after "for" over just its first word.
    const after = text.slice(text.toLowerCase().lastIndexOf(" for ") + 5).toLowerCase();
    const fullName = add === bareAdd ? undefined : world.household.members.find((m) => after.startsWith(m.name.toLowerCase()))?.name;
    const forWhom = add === bareAdd ? target : /^(me|myself|mine|us)$/i.test(add[2]) ? (msg.memberId ?? target) : (fullName ?? add[2]);
    // Not a phone? A catalog product, or a custom item with the price they gave ("a $90 air purifier").
    const what = add[1].replace(/\$\s*\d[\d,.]*/g, "").replace(/\s+/g, " ").trim();
    const phoneHit = bestMatch(world.catalog.phones, what);
    const productHit = bestMatch(world.catalog.products ?? [], what);
    const stated = (add[1].match(/\$\s*(\d[\d,]*(?:\.\d+)?)/) ?? text.match(/\$\s*(\d[\d,]*(?:\.\d+)?)/))?.[1];
    if (!phoneHit || (productHit && productHit.score > phoneHit.score) || (!productHit && stated)) {
      const qty = what.match(/^(\d+)\s+(?:x\s+)?/i);
      const r = callTool("add_product_to_cart", {
        member: forWhom, product: qty ? what.slice(qty[0].length) : what, quantity: qty ? Number(qty[1]) : undefined,
        price: stated ? Number(stated.replace(/,/g, "")) : undefined, addedBy: msg.memberId,
      }) as { added?: string; error?: string };
      return addedText(r);
    }
    const gb = add[3] ?? add[1].match(/(\d{3,4})\s*(gb)?\b/i)?.[1];
    const phone = add[1].replace(/\b\d{3,4}\s*(gb)?\b/i, "").trim();
    // Not an exact model ("iphone 18": 18 Pro or Pro Max?): show the options and let them pick, never a guess.
    if (missingWords(phoneHit.item, phone).length) {
      const r = callTool("recommend_phones", { member: forWhom, model: modelAsked(phone) ?? phone }) as PhonePicks & { error?: string };
      if (r.error) return `Objection: ${r.error}`;
      const you = r.forWhom === nameOf(msg.memberId);
      const whose = world.household.members.find((m) => m.name === r.forWhom)?.id ?? target;
      return phonePicksText(r, you ? "you" : r.forWhom.split(/\s+/)[0], you ? "your" : `${r.forWhom.split(/\s+/)[0]}'s`, pairsFor(whose, r.picks[0]?.phoneId));
    }
    const r = callTool("add_phone_to_cart", { member: forWhom, phone, storageGB: gb ? Number(gb) : undefined, addedBy: msg.memberId }) as { added?: string; requested?: boolean; error?: string };
    return addedText(r);
  }
  // "add the first one" / "add #2" after a recommendation
  // ---- Editing the cart
  if (CLEAR_CART.test(text)) {
    if (!canManage(msg.memberId)) return `Objection: ${ONLY_PARENTS("clear the family cart")}`;
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
  // A receipt photo can come first ("bought it" + photo), with the total in the next text.
  const pending = msg.memberId ? state.pendingReceipt?.[msg.memberId] : undefined;
  const live = pending && pending.until > Date.now() ? pending : undefined;
  const stated = priceIn(text);
  // Two follow-ups: a total after a receipt photo, or a receipt photo for a purchase we asked about.
  const afterPhoto = live?.seen && stated !== undefined ? live : undefined;
  const photoFor = live && !live.seen && msg.image && stated === undefined ? live : undefined;
  const paid = stated ?? photoFor?.paid;
  if ((BOUGHT.test(text) || afterPhoto || photoFor) && paid !== undefined) {
    const hasReceipt = !!msg.image || !!afterPhoto;
    // "bought the rugged case for $35" is an accessory; "bought my iPhone for $899" is a phone.
    const accBought = photoFor ? photoFor.accessory : (/\bin case\b/i.test(text) ? undefined : accessoryType(text));
    const named = accBought ? undefined : (photoFor ? world.catalog.phones.find((p) => p.id === photoFor.phoneId) : findPhone(world, text));
    // Whose is it? Someone named in the text; "my/for me" means the sender; else whoever has that phone
    // in the cart; else the sender.
    const mentioned = photoFor?.owner ?? mentionedMember(text)?.id ?? afterPhoto?.owner;
    const self = !mentioned && /\b(for me|my|mine|myself|i got me)\b/i.test(text);
    const holders = named ? state.cart.filter((i) => i.kind === "device" && i.phoneId === named.id).map((i) => i.memberId) : [];
    const owner = mentioned ?? (self ? msg.memberId : undefined) ?? (holders.includes(msg.memberId ?? "") ? msg.memberId : holders[0]) ?? target;
    const matched = !mentioned && !self && owner !== msg.memberId && holders.includes(owner);
    // Kids can log their own purchases by text. Logging one as someone else's takes a receipt (or a parent).
    if (owner !== msg.memberId && !canManage(msg.memberId) && !hasReceipt && msg.memberId) {
      (state.pendingReceipt ??= {})[msg.memberId] = { until: Date.now() + RECEIPT_MS, paid, phoneId: named?.id, accessory: accBought, owner };
      const them = nameOf(owner).split(/\s+/)[0];
      return `🧾 To log this as ${them}'s, send a photo of the receipt or order confirmation (or ${them} or a parent can text it). If it's yours, say "bought it for me for ${usd(paid)}".`;
    }
    if (msg.memberId && state.pendingReceipt) delete state.pendingReceipt[msg.memberId];
    const r = callTool("record_purchase", { member: owner, paid, phone: named?.id, accessory: accBought ? (findAccessory(world, accBought)?.id ?? accBought) : undefined, fromReceipt: hasReceipt }) as {
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
  if (BOUGHT.test(text) && msg.image && msg.memberId) {
    (state.pendingReceipt ??= {})[msg.memberId] = { until: Date.now() + RECEIPT_MS, seen: true, owner: mentionedMember(text)?.id };
    return "🧾 Got the receipt. What was the total? (e.g. \"paid $899\")";
  }
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
      return addedText(r, ` (${usd(r.price ?? 0)})`, "");
    }
    const r = callTool("recommend_accessories", { member: target, type: accType }) as {
      forWhom: string; phoneBrand: string; picks: { name: string; price: number; why: string[]; shopUrl: string; shopLinks: { store: string; url: string }[] }[]; error?: string;
    };
    if (r.error) return `Objection: ${r.error}`;
    const whoFor = target === msg.memberId ? "your" : `${r.forWhom.split(/\s+/)[0]}'s`;
    const phoneWord = r.phoneBrand === "Apple" ? "iPhone" : r.phoneBrand === "any" ? "phone" : `${r.phoneBrand} phone`;
    return `🎧 Picks for ${whoFor} ${phoneWord}:\n${r.picks.map((p, i) => `${i + 1}. ${p.name}, ${usd(p.price)}: ${p.why[0]}\n   ${p.shopLinks.map((l) => `${l.store}: ${l.url}`).join("\n   ")}`).join("\n")}\nSay "add the first one" to put it in the family cart, or shop it yourself and text "bought the case for $35".`;
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
    const r = callTool("add_protection", { member: target }) as { added?: string; requested?: boolean; error?: string };
    return r.requested || r.error ? addedText(r) : `🛡️ Added: ${r.added}.`;
  }

  const pick = text.match(/\badd (?:the )?(?:#|number )?(first|second|third|fourth|fifth|sixth|1st|2nd|3rd|4th|5th|6th|[1-6])\b/i);
  if (pick) {
    const n = ["first", "second", "third", "fourth", "fifth", "sixth"].findIndex((w) => w === pick[1].toLowerCase()) + 1 || parseInt(pick[1], 10) || 1;
    const r = callTool("add_recommended", { member: target, pick: n }) as { added?: string; requested?: boolean; error?: string };
    return addedText(r);
  }
  // "what laptop should I get?" / "we need a new vacuum under $400"
  const category = findCategory(world, text);
  const shopping = /\b(recommend|suggest|which|what|should (i|we|she|he|they) get|need|looking for|want|best|cheap(est)?)\b/i;
  if (category && shopping.test(text) && !/\bphones?\b/i.test(text)) {
    const budget = text.replace(/,(\d{3})/g, "$1").match(/(?:under|below|less than|max|up to)\s*\$?\s*(\d{2,5})/i)?.[1];
    const r = callTool("recommend_products", {
      member: target, category, budget: budget ? Number(budget) : undefined,
      cheap: /\b(cheap(est)?|budget|affordable)\b/i.test(text), best: /\b(best|top|high[- ]end)\b/i.test(text),
    }) as { forWhom: string; category: string; picks: { name: string; price: number; why: string[]; priceDrop?: { price: number; inDays: number } }[]; error?: string };
    if (r.error) return `Objection: ${r.error}`;
    const whoFor = target === msg.memberId ? "you" : r.forWhom.split(/\s+/)[0];
    const drop = (p: { priceDrop?: { price: number; inDays: number } }) => (p.priceDrop ? ` (drops to ${usd(p.priceDrop.price)} in ${p.priceDrop.inDays} days)` : "");
    return `The court's ${r.category} picks for ${whoFor}:\n${r.picks.map((p, i) => `${i + 1}. ${p.name}, ${usd(p.price)}${drop(p)}: ${p.why.slice(0, 2).join("; ")}`).join("\n")}\nSay "add the first one" to put it in the family cart.`;
  }

  // "I want a phone with long battery life" / "what phone should Grandma get?"
  const said = parsePrefs(text.replace(URLS, " "));
  const asking = /\b(recommend|suggest|which phone|what phone|should (i|we|she|he|they) get|need a (new )?phone|looking for|i want|i need|i'?d like|prefer|care about|something (with|that))\b/i;
  // Any message that says what they care about gets fresh picks ("actually I also want a bigger screen").
  if (asking.test(text) || hasPrefs(said)) {
    // Asking for Grandma when she isn't in the family: say so, don't quietly pick for the sender instead.
    if (/\b(grandma|grandmother|abuela)\b/i.test(text) && !memberByTitle(world, text)) {
      return "Grandma isn't in your family on Cart Court. A parent can add her on the setup page (her name, Grandparent, and her current phone), and the court will pick for how she uses a phone.";
    }
    const r = callTool("recommend_phones", { member: target, model: modelAsked(text) }) as PhonePicks;
    const you = target === msg.memberId;
    return phonePicksText(r, you ? "you" : r.forWhom.split(/\s+/)[0], you ? "your" : `${r.forWhom.split(/\s+/)[0]}'s`, pairsFor(target, r.picks[0]?.phoneId));
  }
  // A private aside ("money's tight, don't tell the kids"): acknowledge, never repeat it.
  if (!msg.isGroup && /\b(tight|budget|afford|broke|expensive|money|bills?|don'?t tell)\b/i.test(text)) {
    return "Noted. That stays between us, and the court will keep it in mind. ⚖️";
  }
  // Small talk gets a short answer, not the whole menu (the menu is for "hi", "help" and things the court didn't follow).
  if (/^\W*(thanks|thank you|thx|ty|tysm)\b[\s\w,!.]{0,20}$/i.test(text)) return "⚖️ Anytime. The court stands by.";
  if (/^\W*((ok(ay)?|k+|fine|alright)([\s,]+(fine|then|cool))?|cool|got it|sounds good|nice|bet|lol|lmao|haha+)\W*$/i.test(text)) return "⚖️ Noted.";
  return [
    "⚖️ The court is listening. You can:",
    "• Paste a store link to add it to the family cart",
    "• Ask \"what phone should I get?\" (say what matters: battery, big screen, camera, budget), or \"what laptop should Maya get?\"",
    "• Add anything with its price: \"add a $90 air purifier for us\"",
    "• Ask for a case, charger, screen protector or earbuds",
    "• Say \"bought it for $899\" when you buy something, or (parents) \"remove my phone\", \"cart clear\", \"approve\"",
    "• Ask \"what's in the cart?\" to see where everything stands",
    "• Say \"court, rule\" when the family is ready to check out",
  ].join("\n");
}

// ---------------------------------------------------------------- who may do what
// Without a group chat everyone talks to the court 1:1, so the court enforces the house rules itself:
// parents (and partners) run the cart; everyone else can add things and edit only their own items.
// The dashboard is always allowed (it's the admin view).

const ONLY_PARENTS = (what: string) => `Only a parent can ${what}.`;

export { canManage };

/** "Added to the family cart", or, for a kid, "sent to Mom and Dad for an OK". */
function addedText(r: { added?: string; requested?: boolean; error?: string }, extra = "", tail = " Nobody checks out until the court rules.") {
  if (r.error) return `Objection: ${r.error}`;
  if (r.requested) {
    const parents = world.household.members.filter((m) => canManage(m.id)).map((m) => m.name.split(/\s+/)[0]);
    return `📨 Asked ${parents.join(" and ") || "a parent"} to OK it: ${r.added}${extra}. A parent texts "approve" to put it in the family cart.`;
  }
  return `📥 Added to the family cart: ${r.added}${extra}.${tail}`;
}

/** Why this person can't run this tool, or null if they can. */
export function guard(memberId: string | undefined, name: string, args: Record<string, unknown>, ctx: { image?: boolean } = {}): string | null {
  if (canManage(memberId)) return null;
  // Logging a purchase as someone else's takes a receipt photo (or a parent).
  if (name === "record_purchase" && args.member && args.member !== memberId && !ctx.image) {
    return "To log a purchase as someone else's, send a photo of the receipt (or that person or a parent can text it).";
  }
  if (name === "clear_cart") return ONLY_PARENTS("clear the family cart");
  if (name === "reassign_purchase") return ONLY_PARENTS("change who a purchase was for");
  if (name === "set_budget") return ONLY_PARENTS("set the family budget");
  if (name === "approve_request" || name === "deny_request") return ONLY_PARENTS("approve what goes in the cart");
  // Kids ask; parents edit. Buying something still takes it out of the cart ("bought it for $899").
  if (name === "remove_from_cart" || name === "change_cart_item") {
    return `${ONLY_PARENTS(`${name === "remove_from_cart" ? "take things out of" : "change"} the family cart`)} Bought it? Text "bought it for $…" and it comes off.`;
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
