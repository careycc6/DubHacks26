// iMessage send effects for the two moments that deserve one: the verdict lands with a Slam, and
// "it's time to buy" arrives with confetti. Everything else is plain text, so the effects stay special.
// If Photon rejects an effect, the message goes out plain (see channels/photon.ts).
// CART_COURT_EFFECTS=off turns them off.
export type Effect = "slam" | "confetti";

export function effectFor(text: string): Effect | undefined {
  if (process.env.CART_COURT_EFFECTS === "off") return undefined;
  if (text.startsWith("⚖️ THE COURT RULES")) return "slam";
  if (text.startsWith("⏳➡️✅")) return "confetti";
  return undefined;
}
