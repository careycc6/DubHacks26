# Devpost submission draft

Copy each section into the matching Devpost field. **The draft is due Sat 10/17 before 10:30 PM. The final is due Sun 10/18 before 10:00 AM.**

**Project name:** Cart Court

**Tagline (short description):**
An honest phone-shopping assistant that lives in your family group chat. It turns links and arguments into one cart, puts it on trial before checkout, and isn't afraid to say "wait."

**Tracks:**
- Title track: **Chef's Choice**
- Sponsored side tracks: **T-Mobile** (phone shopping), **Photon** (messaging agent on Photon 2.0), *optional third:* VEYZL
- Non-sponsored: [MLH] Best Use of Gemini API

**Built with:** TypeScript, Node.js, Express, Photon 2.0 (Spectrum SDK, iMessage), Google Gemini API, Server-Sent Events, HTML/CSS

---

## Inspiration
T-Mobile's challenge opened with *"Phone shopping is broken. You probably have four tabs open about it right now."* We
recognized that from real life, except in our families the tabs come with a group chat full of arguments. The kid
wants the Pro Max. Dad wants to upgrade "while we're at it." Nobody knows whether now is even the right time.
T-Mobile ended with *"Everyone will build the chatbot. Bring the one that says wait."* We took that literally.

## What it does
Cart Court is an agent with a real phone number (via **Photon 2.0**) that you add to your household's group chat.

- **Close your tabs.** Paste a store link and it's filed into one shared family cart.
- **Matchmaker.** "What phone should Grandma get?" It suggests phones based on how that person actually uses one: a flip phone with big buttons for Grandma, the camera Mom actually uses.
- **Cart on trial.** Before checkout, every item gets a ruling, **KEEP / SWAP / WAIT / CUT**, with exact numbers. It swaps storage nobody needs, catches forgotten trade-ins, cuts add-ons nobody has used in a year, and says **WAIT** when a promo is coming or a phone is still healthy and still being paid off.
- **Waiting is part of buying.** Held items stay in the cart. When the moment comes, the court texts the group: *"Marco, it's time. Your iPhone 17 Pro is ready at $407 instead of $1,099."*
- **Evidence.** Send a photo of a cracked screen or a battery-health screenshot and Gemini reads it as **Exhibit A**. The ruling updates: a cracked screen on a healthy phone gets a $129 repair, not a $1,399 phone.
- **Approach the bench.** Anyone can text the court privately ("money's tight this month, don't tell the kids"). That shapes the ruling, but the court never reveals who said what.
- **Life changes.** When a kid leaves for college, it compares the family line ($20/mo) with a solo plan ($40/mo) and rules **STAY**. When the kid grows up, the roles flip, and they're the one shopping for Grandma.
- **A live case file** (shared link) shows the cart, every ruling with its stamp, the evidence, a "when to buy" timeline, and the savings.

In our demo household the court takes the cart from **$3,933 to $709 spent today**, holds $976 for the right moments, and saves **$2,348**.

## How we built it
- **Photon 2.0 / Spectrum SDK** connects the agent to iMessage. It handles group chats and direct messages, image attachments and replies. A local chat simulator mirrors the same flow for development.
- **Gemini** handles the conversation, reads photos and decides which tool to call. The tools are: recommend phones, add to cart, file a link, enter evidence, run the trial, and the leaving-home calculator.
- **A deterministic pricing engine** (plain TypeScript, unit-tested) produces every number: fit scoring, storage headroom, trade-ins, promo timing, payment payoff dates and plan math. **The AI never does math.**
- **Taste rules:** the court stays silent while the family chats and only speaks when it's called, handed a link or a photo, or when a held item is ready.
- **The live case file** updates over Server-Sent Events. It has a legal-document design with animated verdict stamps.
- **Resilience for a live demo:** the verdict skips the AI entirely, and Gemini calls rotate across models on rate limits, with a per-call timeout and a deterministic fallback.

## Challenges we ran into
- **Making an AI trustworthy with money.** A language model will confidently "estimate" a saving. We moved every number into a tested engine and gave the AI only tools.
- **Group-chat manners.** An agent that answers every message is unbearable. Deciding when *not* to speak became a feature.
- **Private context without leaks.** Using a private DM to shape a public ruling without ever revealing it.
- **Free-tier limits.** We built model rotation, timeouts and deterministic fallbacks so the demo can't stall.

## Accomplishments that we're proud of
- An agent whose signature move is honest restraint: "wait 41 days, it'll be $692 cheaper."
- One shopping flow that covers all five of T-Mobile's directions (Matchmaker, Cart Whisperer, Next Best Moment, Timekeeper, Household Mix).
- The old phone gets a "witness statement" before it's replaced.

## What we learned
Trust beats conversion. A shopping assistant that will tell you *not yet* is the one you keep in your group chat for years.

## What's next for Cart Court
- Real catalog and account APIs instead of synthetic data
- Voice: the court calls the person who lost the ruling (Photon SIP)
- Price-drop watching on held items
- Splitting costs among roommates and couples

---

*All data is synthetic. No real customer, account, or transaction data is used.*

**Before submitting:**
- [ ] Add the public GitHub link
- [ ] Add every teammate as a contributor, with their Discord
- [ ] Add screenshots: the case file after the trial, the group chat, an Exhibit on mobile
- [ ] Add the demo video link if you recorded one
