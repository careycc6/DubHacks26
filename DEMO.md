# Cart Court: Demo Script (3 minutes)

> **One line:** Cart Court is an honest phone-shopping assistant that lives in your family group chat. It turns the
> mess of links and arguments into one cart, puts the cart on trial before checkout, and is willing to say *wait*.

## Before judges walk up (60 seconds)

- [ ] Server running: `npm run dev` (terminal shows `[llm] Gemini…` and `[photon] connected`)
- [ ] **Screen A (projector):** `http://localhost:3000`, the dashboard (case file + household + activity + Rule now + Demo tools)
- [ ] **Screen B:** real phones texting the court. Backup if Wi-Fi or Photon fails: `http://localhost:3000/sim` (a simulated chat, not linked from the app)
- [ ] Click **Reset** in the simulator
- [ ] Backup video open in a tab, in case the Wi-Fi dies

Roles: **Presenter** talks. **Driver** clicks and types in the simulator, and plays Elena in the DM.

---

## The script

### 0:00, the hook (Presenter)
> "Phone shopping is broken. You have four tabs open, your kid wants the Pro Max, and nobody knows if now is even the
> right time to buy. T-Mobile asked for the one that says *wait*. We built a judge for your family group chat."

### 0:15, the argument (Driver clicks **▶ Play the argument**)
The family argues in the group chat, line by line. Maya pastes a store link, and the court files it at once:
*"📎 Filed into the family cart: iPhone 17 Pro Max 512GB for Maya ($1,399). You can close that tab."*
Dad says "let's just order everything tonight."
**Point out:** the court ignored the chatter. It only speaks when it's called or handed something to shop with,
like that link. "Close your tabs. Text them to us."
Then it posts the result: *"📥 Entered into the family cart… Sticker total $3,597."* The case file fills with **PENDING** cards.
> "Photon's track asks for agents that join human conversations with taste. It doesn't jump in on every message."

### 0:40, approach the bench (Driver switches to the **🔒 Elena ↔ Court** tab)
Driver types: **`honestly money is tight this month, please don't tell the kids`**
> "Anyone can text the court privately. Watch what happens to the ruling, and notice it never reveals who said what."

No need to wait for the court's DM reply (Gemini can take 5–20 seconds). The note counts the moment it's sent, so go straight to the trial.

### 0:55, the trial (Driver back in **Family group**, as Marco)
Driver types: **`ok court, rule. we want to check out tonight`**
Stamps land on the case file. **Read the projector, not the chat:**

| Who | Ruling | Why |
|---|---|---|
| Elena | **SWAP** Pixel 10 Pro → Pixel 10 | Pixel 7 battery at 71%: buy now, but the Pixel 10 has the camera she uses. **$709** after trade-in + launch credit |
| Maya | **WAIT** until day 120, as iPhone 17 256GB | Battery 88%, 4 payments left, uses 61GB and no Pro features. **$1,399 → $569** |
| Marco | **WAIT** until day 41 | Battery 89%, and a $312 trade-in promo starts in 41 days. **$1,099 → $407** |
| Account | **CUT** ×2 | Device Protection on a dead tablet, plus Hotspot nobody used. **$336/yr** |

> "Spend today: **$3,933 → $709**. The court saved this family **$2,348**, and Dad's phone gets to testify."

Point at Marco's **witness statement**: *"I am Marco's iPhone 15 Pro… I'd like to be heard before I'm replaced."*

### Optional, if a judge asks "what if her phone is actually broken?"
Driver (as Maya, group chat) attaches a photo of a cracked screen or a battery-health screenshot, then types **`see??`**
→ *"Exhibit A entered…"* The evidence card appears on the case file and Maya's ruling updates. A cracked screen on a
healthy phone becomes a **$129 repair today**, still WAIT on the new phone. A low battery flips her to buy-now.
Without Gemini, type it instead: **`court, my screen is cracked`** or **`court, battery is 76%`**.

### 1:45, waiting is part of buying (Driver clicks **+41 days**)
The group gets: *"⏳➡️✅ Marco, it's time. Your iPhone 17 Pro is ready at $407 instead of $1,099."*
> "WAIT isn't 'no sale.' It's a held cart. It comes back when the price is right. That's the trust T-Mobile wants."

### 2:05, the kid grows up (Driver clicks **+120 days**, then **+2 years**)
Driver types as Elena: **`court, maya is leaving for college in august`**
→ **STAY** on the family plan: $20/mo vs $40 solo, **saves $240/yr**, same number.
Driver types as Maya: **`court, what phone should we get grandma? she keeps butt-dialing me`**
→ Easy Flip 5, $149.
> "When the kid grows up, the chat doesn't end. The roles flip. The kid who was told to wait is now shopping for Grandma."

### 2:40, close (Presenter clicks **Proceed to checkout**)
> "Every number you saw came from a deterministic pricing engine. The AI talks, the engine does the math, so it never
> makes up a price. Cart Court lives on a real phone number through Photon, works in iMessage group chats, and tells
> you the truth about your cart, including 'not yet.'"

---

## Judge Q&A: have these ready

**"Isn't the AI making up prices?"**
No. Gemini only talks and picks tools. Every price, date and saving comes from `engine.ts`, which is plain code with 12
unit tests. The verdict text skips the AI entirely.

**"Why would T-Mobile want a bot that tells customers not to buy?"**
Because trust is what keeps customers. A carrier that says "wait 41 days, it'll be $692 cheaper" is one you don't
leave, and the sale still happens, at the right moment.

**"What happens when the kid grows up?"**
The household changes, the chat stays. Leaving home (STAY or LEAVE), roommates, couples, adult kids shopping for
aging parents. It also works one-on-one.

**"Doesn't it get annoying in a group chat?"**
It only speaks when called, handed a link or photo, or when a held item is ready. A few messages a year.

**"Privacy? It used Mom's DM."**
Private messages can shape a ruling, but the agent is instructed never to reveal or hint at them, and the case file
page never sees DMs.

**"How is this different from a shopping chatbot?"**
A chatbot answers one person. Cart Court sits in a conversation between people, keeps one shared cart, and its
signature move is the honest "wait."

**"Real data?"**
Synthetic only, per T-Mobile's rules. The engine takes plain JSON, so it could be swapped for real catalog and account APIs.

## If something breaks

| Problem | What happens / what to do |
|---|---|
| Gemini rate limit (free tier is 5/min) | Replies fall back to rules mode automatically. The trial never uses Gemini. Keep typing "court, …" commands |
| Photon / Wi-Fi down | The simulator runs fully local. Keep going |
| Everything down | Play the backup video |
| Need a clean slate | **Reset** button, then **Seed cart (instant)** skips the argument |

## Numbers cheat sheet
- Sticker total argued: **$3,597** · first-year cart incl. unused add-ons: **$3,933**
- Spend today after ruling: **$709** (without Mom's DM: **$909**)
- Held: **$976** · Total saved: **$2,348**
- Dad: day 41, $1,099 → $407 · Maya: day 120, $1,399 → $569 · Maya stays on plan: $240/yr
