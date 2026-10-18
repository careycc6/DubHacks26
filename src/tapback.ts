// iMessage tapbacks on the court's messages. Long-press a ruling and tap 👎 to appeal it, or ❓ to ask
// why; no typing needed. 👍 ❤️ 😂 ‼️ are applause: logged, never answered (a bot that replies to a 👍
// is noise). The simulator offers the same tapbacks, so the web demo behaves like the phone.

/** What iMessage itself calls each tapback ("Disliked “…”"), for the chat log. */
const VERB: Record<string, string> = { "👎": "Disliked", "❓": "Questioned", "👍": "Liked", "❤️": "Loved", "😂": "Laughed at", "‼️": "Emphasized" };

/** Court messages that carry a ruling someone could push back on. */
const RULING = /THE COURT RULES|asked the court to rule|APPEAL (DENIED|GRANTED|PARTLY GRANTED)|ruling is|\bWAIT\b|\bBUY\b|Overruled|Reinstated/;

/** The message the court should act on for this tapback, or undefined to stay quiet. */
export function tapbackText(emoji: string, targetText: string | undefined, fromCourt: boolean): string | undefined {
  if (!fromCourt || !targetText || !RULING.test(targetText)) return undefined;
  // A tapback on a message about one person (an appeal result) is about that person's ruling.
  const about = targetText.match(/APPEAL (?:DENIED|GRANTED|PARTLY GRANTED), (\w+)|Why (\w+)'s ruling/);
  const name = about?.[1] ?? about?.[2];
  if (emoji === "👎") return name ? `I appeal for ${name}` : "I appeal";
  if (emoji === "❓") return name ? `why ${name}?` : "why?";
  return undefined;
}

/** The line the chat log shows, the way iMessage shows a tapback on a phone that can't render it. */
export function tapbackLog(emoji: string, targetText = ""): string {
  const quote = targetText.split("\n")[0].slice(0, 40);
  return `${VERB[emoji] ?? `Reacted ${emoji} to`} “${quote}${targetText.split("\n")[0].length > 40 ? "…" : ""}”`;
}

export const TAPBACKS = Object.keys(VERB);
