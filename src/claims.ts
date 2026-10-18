// Who is texting? Maps real phone numbers / Apple IDs to household members.
// Numbers in data/household.json are matched first; anyone else introduces themselves in chat
// ("I'm Maya") and the claim is saved (db.ts: MongoDB or data/claims.local.json) so it survives restarts.
import { savedMemberIds } from "./data.ts";
import { get, put } from "./db.ts";
import { world } from "./store.ts";

const claims = get<Record<string, string>>("claims", {});
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
  const roles: [RegExp, (m: { role: string; id: string }) => boolean][] = [
    [/\b(dad|father)\b/, (m) => m.id === "marco"],
    [/\b(mom|mum|mother)\b/, (m) => m.id === "elena"],
    [/\b(grandma|grandmother|abuela)\b/, (m) => m.role === "grandparent"],
  ];
  for (const [re, pick] of roles) if (re.test(t)) return world.household.members.find(pick)?.id;
  return undefined;
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

export function welcome(memberId: string) {
  const m = world.household.members.find((x) => x.id === memberId)!;
  return `Welcome to the court, ${m.name}! ⚖️`;
}

/** Numbers that introduced themselves in chat as this member (shown pre-filled on /setup). */
export function claimedHandles(memberId: string): string[] {
  return Object.entries(claims).filter(([h, id]) => id === memberId && h !== SIM_HANDLE).map(([h]) => h);
}
