# Cart Court: proposals for review

Tick the ones you want (`[x]`), cross out or delete the rest, and I'll build the approved ones.
**★ = my top picks** (biggest win for the judges per hour of work). Effort: **S** < 1 h · **M** 1–3 h · **L** half a day+.

Built overnight and already live or on a branch:
- **On `main` (live):** prices shown with and without the trade-in, plan-locked deals that cost more than they give are skipped,
  kids need a receipt photo to log someone else's purchase, battery health is optional (worn batteries on newer phones get a
  battery-replacement suggestion), official store links (T-Mobile first, then Apple / Samsung / Google Store), family feed goes
  to a Photon group chat when there is one, and 15 new tests (36 on main; `login` adds 4 sign-in tests): permissions, cart-clear confirm, receipts, reassigning a purchase, the family feed, and private DMs staying private.
- **On branch `login` (not merged):** Sign in with Google / Apple, `/welcome` setup guide, "Who can sign in" in Settings.
  Needs `GOOGLE_CLIENT_ID` (and optionally `APPLE_CLIENT_ID`, `SESSION_SECRET`) before it does anything. See ONBOARDING §5.
  **Before merging:** the live court already has a saved family, so the first Google sign-in only becomes owner if that browser
  has also opened the `?key=ADMIN_TOKEN` link (or the email is in `OWNER_EMAILS`). Set `OWNER_EMAILS` to your Gmail first.

---

## 1. Demo and judging impact (Chef's Choice)

- [ ] ★ **S · "Receipt" moment in the demo script.** Add a beat to DEMO.md: Maya claims Marco's phone, the court asks for a receipt, she sends a photo, it logs. Shows the house rules live in 20 seconds.
- [ ] ★ **M · One-tap "Judge mode" on `/cart`.** A judge texts the court and their number joins a sandbox household seeded with the demo family, so every judge gets their own trial without touching ours.
- [ ] ★ **S · Savings ticker on the dashboard.** One big number: "Cart Court has saved this family $X" (sum of verdict savings + purchases under sticker). Judges remember one number.
- [ ] **S · Verdict share card.** A PNG of the verdict (stamps + savings) generated server-side, sent as an iMessage image after "court, rule". Much more striking in the chat than text.
- [ ] **M · "Before vs. after" view.** Toggle on the case file: the cart as the family wanted it vs. as the court ruled, with a running difference.
- [ ] **S · 60-second demo reset.** One dashboard button that resets, seeds the argued cart, and pre-fills Day 0, so the live demo always starts clean.
- [ ] **S · Print/PDF the case file.** A print stylesheet so "SO ORDERED" can be handed to a judge.
- [ ] **M · Narrated timeline.** Under the case file: "Day 0: family argued · Day 41: Marco's trade-in deal starts · Day 120: Maya's payments end", with what each step saves.

## 2. T-Mobile track (realistic carrier pricing)

- [ ] ★ **M · Real T-Mobile plan tiers.** Model Essentials / Go5G / Go5G Plus / Next-style tiers with per-line prices and which deals each unlocks, so "needs a pricier plan" compares against actual tiers, not a flat +$20.
- [ ] ★ **S · Show the 24-month bill-credit math.** On every trade-in deal: "$312 off = $13/mo for 24 months. Leave early and you forfeit the rest." Makes the court the honest one.
- [ ] **M · Trade-in condition questions.** "Does it power on? Cracked screen?" adjusts the trade-in value (good / fair / broken tiers), like the carrier quote flow.
- [ ] **S · Port-in / new-line deals.** A promo type for "add a line" offers; the court says when adding a line for the teen is cheaper than upgrading the parent's.
- [ ] **M · Device payment plan view.** Show monthly cost (price ÷ 24) next to the full price, since that's how families actually compare phones at T-Mobile.
- [ ] **S · "Already paid off" bonus.** When a phone is paid off and healthy, say how much the family saves each month by keeping it.
- [ ] **M · Plan right-sizing.** Look at each person's data use (synthetic) and suggest dropping a tier or adding a line on the family plan.
- [ ] **S · Verify the T-Mobile search link by hand.** t-mobile.com blocks automated checks, so I couldn't confirm `t-mobile.com/search?q=` lands on results. 30 seconds in your browser; if it doesn't, I'll point to the accessories category page instead.
- [ ] **S · Device Protection pricing by phone tier.** Protection 360 prices vary by device tier; use the tier instead of one flat price.

## 3. Photon / iMessage track

- [ ] ★ **M · Tapbacks as votes.** When the court proposes a pick, family members ❤️ or 👎 it; the court tallies votes before ruling. Very native to iMessage and good for the Photon judges.
- [ ] ★ **S · Typing indicator while thinking.** Show "…" while Gemini works (Spectrum supports `responding`); already used in stream mode, make sure webhook mode does it too.
- [ ] **M · Read screenshots of store pages.** A screenshot of a T-Mobile/Apple product page becomes a cart item (model + storage + price) via Gemini vision, like pasting a link.
- [ ] **S · Rich link previews.** Send the case file URL on its own line so iMessage renders a preview card with an Open Graph image (add `og:` tags to `/cart`).
- [ ] **M · Group chat on the dedicated line.** Backend is ready (posts to the group when one exists). Test end-to-end once a Business line is available, and add "taste gating" so the court stays quiet unless addressed.
- [ ] **S · Quiet hours.** No proactive texts 9pm–8am in the family's time zone; queue "it's time" alerts until morning.
- [ ] **S · Per-person mute.** "court, mute the updates" stops feed relays to that person but keeps direct replies.
- [ ] **S · Message batching.** If three changes happen within a minute, relay one combined update instead of three texts.

## 4. Onboarding, sign-in and settings

- [ ] ★ **S · Set `GOOGLE_CLIENT_ID` and merge `login`.** About 5 minutes in Google Cloud Console (steps in ONBOARDING §5). Then parents sign in from any phone instead of using the admin link.
- [ ] ★ **M · Guided setup that writes the family inline.** The `/welcome` guide currently links to Settings for the family table; embed the table in step 1 so the whole setup happens on one page.
- [ ] **M · Invite by text, not email.** "Add a co-parent" sends them an iMessage with a one-time sign-in link, since everyone already has the court's number.
- [ ] **S · Show the court's number as a contact card.** A `.vcf` download ("Cart Court ⚖️") on the guide so families save it in one tap.
- [ ] **S · Role editing on the dashboard.** Change someone's role (teen → parent) from the people card, not just Settings.
- [ ] **M · Multi-household (one court, many families).** Today one deployment = one family. Key every record by household so each signed-in parent gets their own. Needed before anyone outside the team uses it.
- [ ] **S · First-text tutorial.** After the welcome, the court's second message is three example texts tailored to the person's role (teen: "what phone should I get?", parent: "set our budget to $2,000").
- [ ] **S · Settings: house rules toggles.** Let parents choose: kids can/can't add phones, receipt required for others' purchases, budget visible to kids.
- [ ] **S · Sign-in on the case file.** If a signed-in parent opens `/cart`, show a "Manage →" link back to the dashboard.

## 5. Agent and conversation quality

- [ ] ★ **M · Explain every verdict in one line, in the person's own words.** After the rules-based verdict, add a short LLM line that ties it to what they said they wanted ("You wanted battery life: the Pixel 10 gets 31h for $400 less").
- [ ] ★ **S · Undo by text.** "court, undo" reverts the last change the sender made (add, remove, purchase), with the feed saying so.
- [ ] **S · "What's in the cart?"** A rules-mode reply listing each person's items and the current total, without running a trial.
- [ ] **S · Budget check by text.** "how much budget is left?" answers from the engine (spent + planned vs. budget).
- [ ] **M · Compare two phones.** "court, iPhone 17 vs Pixel 10" returns a side-by-side (price with trade-in, battery, camera, storage) and who it's better for.
- [ ] **S · Better unknown-item labels.** A receipt with no model named is logged as "a phone"; ask "Which phone was it?" instead of guessing.
- [ ] **S · Friendlier objections.** Permission refusals currently start with "Objection:"; add the next step every time ("Ask Elena or Marco, they can do it").
- [ ] **M · Remember each person's style.** If someone always says "under $600", keep it as their default budget until they change it (already stored as prefs, surface it in replies).
- [ ] **S · Spanish replies.** If a person texts in Spanish, reply in Spanish (Gemini handles it; rules mode keeps English). Strong for family/grandparent demos.
- [ ] **M · Grandparent mode.** For grandparent roles: shorter replies, bigger "BUY / WAIT" words, no links unless asked.
- [ ] **S · Rate-limit the LLM per person.** Cap Gemini calls per person per minute so one spammy teen can't burn the quota.

## 6. Pricing engine correctness

- [ ] ★ **S · Battery replacement as a real option in the trial.** Today it's a reason line. Make it a priced alternative ("KEEP + $99 battery") the family can accept, like the screen repair.
- [ ] **S · Trade-in only once.** If two people's carts both count the same old phone's trade-in (hand-me-down cases), only credit it once.
- [ ] **M · Hand-me-down chain.** When a parent upgrades, offer the old phone to the teen and skip the teen's purchase ("Marco's 15 Pro → Maya, Maya's 14 traded in").
- [ ] **S · Storage advice from usage.** Already swaps storage down; also say why ("You use 61 of 128GB; 256GB is plenty").
- [ ] **S · Tax estimate.** Show "about $X with tax" using a configurable rate, so the total isn't a surprise at checkout.
- [ ] **M · Price history sparkline.** On each phone, a small 120-day chart of the synthetic price with promo dips marked.
- [ ] **S · Promo stacking rules.** Make explicit which promos stack (launch credit + trade-in) and which don't, with a test.
- [ ] **S · Purchase vs. court price on the dashboard.** Show "paid $X vs. court price $Y" per purchase, highlighting overpays.

## 7. Dashboard and case file UX

- [ ] ★ **S · Mobile pass on the dashboard.** Check every card at 375px width (people card and cart actions wrap awkwardly).
- [ ] **S · Empty states.** Friendly copy for an empty cart ("Paste a store link in iMessage to start a case"), no rulings yet, no purchases.
- [ ] **S · Dark mode.** The paper theme with an "ink" dark variant via `prefers-color-scheme`.
- [ ] **S · Toasts for dashboard actions.** Confirm "Removed Maya's case" with an Undo for 5 seconds.
- [ ] **M · Drag to reassign.** Drag a purchase onto another person to fix who it was for (parents only).
- [ ] **S · Per-person filter.** Click a person to see only their items, rulings and purchases.
- [ ] **S · Activity feed links.** Each feed line links to the item it's about.
- [ ] **S · Accessibility pass.** Verdict colors also carry text/icons (already mostly), buttons get labels, focus rings visible, contrast checked.
- [ ] **S · Favicon + app manifest.** So the case file can be added to a phone's home screen with the ⚖️ icon.

## 8. Trust, safety and privacy

- [ ] ★ **S · Private case-file link.** `/cart` and `/api/state` are public and show the family's real names. Add a per-family share token (`/cart/<token>`) that the court texts, and show initials to anyone without it.
- [ ] ★ **S · Don't store receipt photos longer than needed.** Keep the parsed total and drop the image after filing (or after 7 days).
- [ ] **S · Audit log for parents.** Who cleared the cart, reassigned a purchase or changed the budget, with time. Already mostly in the feed; add a filtered view.
- [ ] **S · Webhook replay protection.** Reject Photon webhooks older than 5 minutes or with a repeated id (check what Spectrum's signature already covers).
- [ ] **S · Secure headers.** `helmet`-style headers (CSP for the dashboard, `X-Frame-Options`, `Referrer-Policy`).
- [ ] **S · Rate-limit sign-in and setup endpoints.** Basic per-IP limits on `/api/auth/*`, `/api/setup/*`.

## 9. Reliability and operations

- [ ] ★ **S · Health check that covers everything.** `/healthz` also reports Gemini reachable, last webhook received, and Mongo latency; show it on the dashboard chips.
- [ ] **S · Gemini fallback message.** When every model is rate-limited, say so once ("I'm in quick mode for a bit") instead of silently switching.
- [ ] **S · Idempotent webhooks.** If Photon retries a webhook, don't reply twice (dedupe by message id).
- [ ] **M · Background reminders on Vercel.** Held items' "it's time" texts only fire when someone advances the demo clock. Add a Vercel Cron that checks real dates daily.
- [ ] **S · Error reporting.** Log errors to the dashboard ("2 errors in the last hour") so you notice during the demo.
- [ ] **S · Backup/export.** "Download family data (JSON)" in Settings, and a matching import.

## 10. Testing

- [ ] ★ **M · Golden conversation tests.** Ten scripted conversations (the demo script, receipts, budget, college) run through the rules path and compare replies to saved snapshots, so wording changes are deliberate.
- [ ] **M · Browser smoke test.** A Playwright run over `/login`, `/welcome`, `/dashboard`, `/cart` at phone and desktop widths, run before each push.
- [ ] **S · Webhook test.** A signed sample Photon payload through `/api/photon/webhook` in serverless mode.

## 11. Pitch and docs

- [ ] ★ **S · Devpost "how it's different" table.** Cart Court vs. a carrier chatbot vs. a price tracker: shared family cart, trial before checkout, waits for deals, house rules. Three columns, five rows.
- [ ] **S · 90-second video storyboard.** Shot list for the demo video: argument → links → "court, rule" → WAIT → Day 41 "it's time".
- [ ] **S · Architecture diagram.** One image: iMessage → Photon → court (rules + Gemini) → pricing engine → MongoDB → case file.
- [ ] **S · README screenshots.** Dashboard, case file on a phone, and an iMessage thread.
