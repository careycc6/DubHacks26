// Who is texting? Maps real phone numbers / Apple IDs to household members.
// Numbers in data/household.json are matched first; anyone else introduces themselves in chat
// ("I'm Maya") and the claim is saved (db.ts: MongoDB or data/claims.local.json) so it survives restarts.
import { savedMemberIds } from "./data.ts";
import { get, onReload, put } from "./db.ts";
import { memberByTitle, tradeIn, usd } from "./engine.ts";
import { state, world } from "./store.ts";

const claims = get<Record<string, string>>("claims", {});
onReload(() => {
  for (const k of Object.keys(claims)) delete claims[k];
  Object.assign(claims, get<Record<string, string>>("claims", {}));
});
/** The simulator's "new phone": claims stay in memory and never show up as a real contact. */
export const SIM_HANDLE = "+15555550199";
const asked = new Set<string>(); // handles we've already asked "who are you?" in a group

const digits = (s: string) => s.replace(/\D/g, "").slice(-10);
const same = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase() || (digits(a).length >= 7 && digits(a) === digits(b));

export function memberForHandle(handle?: string): string | undefined {
  if (!handle) return undefined;
  const fromFile = world.household.members.find((m) => m.handles.some((h) => same(h, handle)));
  if (fromFile) return fromFile.id;
  const key = Object.keys(claims).find((k) => same(k, handle));
  return key ? claims[key] : undefined;
}

export function claim(handle: string, memberId: string) {
  claims[handle] = memberId;
  put("claims", Object.fromEntries(Object.entries(claims).filter(([h]) => h !== SIM_HANDLE)));
}

/** Demo reset: forget the simulator's fake phone only. Real people stay linked. */
export function forgetClaims() {
  delete claims[SIM_HANDLE];
  asked.clear();
}

/** Find a member name in an intro like "I'm Maya", "maya", "this is dad". */
export function introducedAs(text: string): string | undefined {
  const t = text.toLowerCase();
  const word = (w: string) => new RegExp(`\\b${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t);
  const byName = world.household.members.find((m) => word(m.name) || word(m.name.split(/\s+/)[0])); // "I'm Jaret" or "Jaret Zhang"
  if (byName) return byName.id;
  return memberByTitle(world, t)?.id;
}

/** Ask once per handle in a group; always ask in a DM until they answer. */
export function shouldAsk(handle: string, isGroup: boolean) {
  if (!isGroup) return true;
  if (asked.has(handle)) return false;
  asked.add(handle);
  return true;
}

export function welcomeQuestion() {
  const saved = savedMemberIds();
  const names = world.household.members.filter((m) => !saved.length || saved.includes(m.id)).map((m) => m.name);
  if (names.length === 1) return `⚖️ Welcome to Cart Court! Is this ${names[0]}? Reply with your name.`;
  return `⚖️ Welcome to Cart Court, the honest phone-shopping assistant for ${world.household.name}. Who's texting? Reply with your name: ${names.slice(0, -1).join(", ")} or ${names.at(-1)}.`;
}

/** The first reply after someone says who they are: what the court knows about them and what to text next. */
export function welcome(memberId: string) {
  const m = world.household.members.find((x) => x.id === memberId)!;
  const first = m.name.split(/\s+/)[0];
  const d = m.device;
  const smartphone = d.storageGB >= 16;
  const mine = state.cart.filter((i) => i.memberId === m.id && i.kind === "device" && i.phoneId)
    .map((i) => `${world.catalog.phones.find((p) => p.id === i.phoneId)?.name ?? "a phone"} ${i.storageGB}GB`);
  const inCart = mine.length ? `\n📥 Already in the family cart for you: ${mine.join(", ")}.` : "";

  // Grandparents get the short, plain version: no jargon, one thing to try.
  if (m.role === "grandparent") {
    return `Welcome to the court, ${first}! ⚖️ I help the family pick phones without overspending.${inCart}\nJust text me in your own words, like "I want a phone that's easy to read" or "what phone should I get?"`;
  }
  const facts = [
    smartphone && `${d.batteryHealth}% battery health`,
    d.installmentsLeft > 0 && `${d.installmentsLeft} payment${d.installmentsLeft === 1 ? "" : "s"} of ${usd(d.monthlyInstallment)} left`,
    tradeIn(m).value > 0 && `worth ${usd(tradeIn(m).value)} in trade${d.screenCracked ? " (cracked screen)" : ""}`,
  ].filter(Boolean);
  const manager = m.role === "parent" || m.role === "partner";
  return [
    `Welcome to the court, ${first}! ⚖️`,
    `On file: your ${d.model}${facts.length ? ` (${facts.join(" · ")})` : ""}. Changed? Text me, like "battery health 79%".${inCart}`,
    "Try:",
    `• "what phone should I get?" (say what matters: camera, battery, budget)`,
    "• Paste a store link to add it to the family cart",
    manager
      ? `• "our phone budget is $2,000", then "court, rule" when everyone's in`
      : `• "court, rule" when everyone's in. The court decides what to buy now and what should wait.`,
  ].join("\n");
}

/** Where to find battery health on this phone (it decides whether a phone can wait). */
export function batteryHowTo(model = "") {
  if (/iphone/i.test(model)) return "On iPhone: Settings → Battery → Battery Health (Maximum Capacity)";
  if (/pixel/i.test(model)) return "On Pixel: Settings → Battery → Battery health";
  if (/galaxy|samsung/i.test(model)) return "On Galaxy: Samsung Members app → Support → Phone diagnostics → Battery status";
  return "iPhone: Settings → Battery → Battery Health. Android: Settings → Battery → Battery health (Galaxy: Samsung Members → Phone diagnostics)";
}

/** Numbers that introduced themselves in chat as this member (shown pre-filled on /setup). */
export function claimedHandles(memberId: string): string[] {
  return Object.entries(claims).filter(([h, id]) => id === memberId && h !== SIM_HANDLE).map(([h]) => h);
}
