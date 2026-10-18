# Cart Court: Demo Script (3 minutes, real phones)

> **One line:** Cart Court is an honest phone-shopping assistant your family texts. It turns everyone's links and
> arguments into one family cart, puts the cart on trial before checkout, and isn't afraid to say *wait*.

**Cast**

| Who | Plays | Their phone story (example data) |
|---|---|---|
| **Presenter** | talks to the judges | none |
| **Driver** (laptop) | runs the dashboard on the projector | none |
| **Carey** | Dad | iPhone 15 Pro, battery 89%, a trade-in promo starts in 41 days |
| **Kairui** | Mom | Pixel 7, battery 71% (dies by 2pm), money's tight this month |
| **Jaret** | the teen | iPhone 14, battery 88%, 4 payments left, wants the Pro Max |

Every line below works **without Gemini** (rules mode). If Gemini is on, the court's replies just get chattier.

---

## Before judges walk up (5 minutes, once)

- [ ] **Server running** on the laptop: `npm run dev`. The terminal shows `[photon] connected`.
- [ ] **Tunnel running** (second terminal): `npm run tunnel`. Open the `https://…trycloudflare.com` URL once on the laptop, so the case-file link the court texts opens on phones.
- [ ] **`localhost:3000/setup`, step 3:** Carey, Kairui and Jaret are saved with their numbers.
      Set **Current phone** to **iPhone 15 Pro / Pixel 7 / iPhone 14** (or leave it blank; those are the defaults).
- [ ] **Text everyone** has been pressed and all three phones got "Welcome to the court, [name]! ⚖️". Save the number as a contact called **Cart Court**.
- [ ] Each teammate has their **store link** ready in Notes (copy and paste is faster than typing):
      - Jaret: `https://store.example.com/iphone-17-pro-max?storage=512`
      - Carey: `https://store.example.com/iphone-17-pro?storage=256`
      - Kairui: `https://store.example.com/pixel-10-pro-256gb`
- [ ] **Projector:** `http://localhost:3000`, the dashboard. Open **Demo tools** and click **Reset cart**.
- [ ] Backup video open in a browser tab, in case the Wi-Fi dies.
- [ ] **Ready for judges?** card on the dashboard: every row is green, or you know why it's amber.

## Between judges (30 seconds)

1. Press **Shift+R** to reset, or **S** to load the pre-trial scene (three links filed plus Kairui's private aside; it starts at 0:45).
2. Glance at **Ready for judges?** The Cart row should say empty or awaiting trial.
3. Mid-demo walk-up? Press **P** to replay the stamps instead of re-ruling. To come back to a moment later,
   use **Demo tools → Save checkpoint**, then Restore. Restoring never texts anyone.
4. "Can I try?" Point them at the **Let a judge try** QR codes. On Photon's free plan, add their number under Users first.

**Dashboard shortcuts** (ignored while typing): **R** Rule now · **1 / 2 / 3** +41 days / +120 days / +2 years ·
**S** pre-trial scene · **Shift+R** reset · **P** replay stamps · **F** case file full screen · **C** hide the cue strip · **?** list.
The cue strip at the top always shows the next beat and the numbers to say.

---

## The script

### 0:00, the hook (Presenter)
> "Phone shopping is broken. Four tabs open, a teenager who *needs* the Pro Max, and nobody knows if now is even the
> right time to buy. T-Mobile asked for the one that says *wait*. We built a court your family can text."

### 0:15, everyone shops from their own phone (Jaret, Carey, Kairui)
1. **Jaret** pastes their link into the Cart Court chat. The court replies *"📎 Filed into the family cart: iPhone 17 Pro Max 512GB for Jaret Zhang ($1,400). You can close that tab."*
2. **Carey** pastes theirs, and **Kairui** pastes theirs.
3. Each time, **the other two phones buzz**: *"📥 Jaret added iPhone 17 Pro Max 512GB to the family cart."*

**Driver points at the projector:** three PENDING cards, the sticker total climbing to **$3,599**, and the Activity feed filling up.
> "Everyone texts the court on their own. It's one shared cart, and everyone sees what everyone else adds. Close your tabs, text them to us."

### 0:45, approach the bench (Kairui, privately)
**Kairui** texts: **`honestly money is tight this month, don't tell the kids`**
→ *"Noted. That stays between us, and the court will keep it in mind. ⚖️"*
> "Anyone can tell the court something privately. Watch the ruling, and notice that nobody else's phone heard a thing."

(Nothing shows on the dashboard or the other phones. That's the point.)

### 1:00, the trial (Driver clicks **⚖️ Rule now** on the dashboard)
All three phones buzz at once:
*"⚖️ The court has ruled. Jaret: WAIT till day 120, Carey: WAIT till day 41, Kairui: SWAP. Spend today $3,935 → $709. Case file: …"*

The stamps land on the projector. **Read the projector:**

| Who | Ruling | Why |
|---|---|---|
| Kairui | **SWAP** Pixel 10 Pro → Pixel 10 | Battery at 71%, so buy now, but the Pixel 10 has the camera she actually uses. **$709** after trade-in and the launch credit (this is the private DM at work) |
| Jaret | **WAIT** until day 120, as iPhone 17 256GB | Battery 88%, 4 payments left, uses 61GB and no Pro features. **$1,400 → $670** |
| Carey | **WAIT** until day 41 | Battery 89%, and a $312 trade-in promo starts in 41 days. **$1,100 → $408** |
| Account | **CUT** ×2 | Protection on a dead tablet, plus Hotspot nobody used. **$336/yr** |

> "Spend today: **$3,935 → $709**. The court saved this family **$2,248**, and Carey's old phone gets to testify."

Point at Carey's **witness statement** on the projector: *"I am Carey Chiu's iPhone 15 Pro… I'd like to be heard before I'm replaced."*

### 1:50, waiting is part of buying (Driver: **Demo tools → +41 days**)
Every phone gets: *"⏳➡️✅ Carey, it's time. Your iPhone 17 Pro 256GB is ready at $408 instead of $1,100. Waiting saved $692."*
> "WAIT isn't 'no sale.' It's a held cart that comes back when the price is right. That's how you earn trust."

(Optional: **+120 days**. Jaret's iPhone 17 is ready at $670 instead of $1,400.)

### 2:10, the kid grows up (Driver: **+2 years**)
- **Kairui** texts: **`court, Jaret is leaving for college in August`**
  → **STAY** on the family plan: $20/mo vs $40 solo, **saves $240/yr**, same number. The other phones get the ruling too.
- **Jaret** texts: **`court, what phone should grandma get? she keeps butt-dialing me`**
  → Easy Flip 5, $149, with big buttons and an SOS key.
> "When the kid grows up the chat doesn't end, the roles flip. The kid who got told to wait is now shopping for Grandma."

### 2:40, close (Presenter)
> "Every number you saw came from a tested pricing engine. The AI talks, the engine does the math, so it never makes up
> a price. It runs on real phone numbers through Photon, and it tells you the truth about your cart, including 'not yet.'"
Click **Proceed to checkout →** on the dashboard to end on the mock store.

---

## Optional beats (if a judge asks)

| Judge asks | Do this |
|---|---|
| "What if her phone is actually broken?" | **Jaret** texts `court, my screen is cracked` (or sends a photo if Gemini is on). It's filed as Exhibit A, and the ruling becomes a **$129 screen repair today**, still WAIT on a new phone. |
| "Can I try?" | Add the judge's number on `/setup` (step 3, the grey row) and press **Text everyone**. Only they get texted. (Their number must be under Users in Photon first, unless you ran the Photon login.) They reply with a link or "court, what phone should I get?" |
| "What does a family member see?" | Open the case-file link from any phone. It's the same ruling, read-only. |

---

## Judge Q&A

**"Isn't the AI making up prices?"**
No. Gemini only talks and picks tools. Every price, date and saving comes from `engine.ts` (plain code, unit-tested).
The verdict itself skips the AI entirely.

**"Why would T-Mobile want a bot that says don't buy?"**
Trust keeps customers. A carrier that says "wait 41 days, it'll be $692 cheaper" is one you don't leave, and the sale
still happens, at the right moment.

**"Why not a group chat?"**
On Photon's free plan each person gets a one-on-one chat (group chats need a paid dedicated line). The court relays every
cart change and ruling to everyone, so it works like a group chat, and private asides stay private.

**"What about privacy? It used Mom's DM."**
Private messages can shape a ruling, but they're never quoted or forwarded. The dashboard and the other phones only see
the ruling itself. Real names and numbers stay on the laptop, never in the repo.

**"What happens when the kid grows up?"**
The household changes and the chat stays: leaving home (STAY or LEAVE), roommates, couples, adult kids shopping for
their parents.

**"Real data?"**
Synthetic only, per T-Mobile's rules. The engine takes plain JSON, so real catalog and account APIs could plug in.

## If something breaks

| Problem | Do this |
|---|---|
| Gemini down / out of quota | Nothing. Replies fall back to rules mode automatically, and every scripted line works there. |
| A phone doesn't buzz | Check `localhost:3000/setup`: Photon should say connected. The number must be under Users in Photon. |
| Photon or Wi-Fi down | Open `localhost:3000/sim` (a backup simulated chat, not linked in the app) and type the same lines there. The dashboard updates the same way. |
| Need a clean slate | Dashboard → **Demo tools → Reset cart** (people and numbers stay saved). |
| Everything down | Play the backup video. |

## Numbers cheat sheet
- Sticker total as argued: **$3,599** · first-year cart including unused add-ons: **$3,935**
- Spend today after the ruling: **$709** (without Kairui's DM it would be **$909**)
- Held: **$976** · Total saved: **$2,248**
- Carey: day 41, $1,100 → $408 · Jaret: day 120, $1,400 → $670 · Jaret stays on the plan: $240/yr
