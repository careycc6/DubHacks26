# Spec: demo features for judging

**Goal:** make the 3-minute demo repeatable for judge after judge, ready to check at a glance, and convincing on the
"the AI never does math" claim. Everything here runs on the hosted server and on a laptop, and works in rules mode
(no Gemini).

**Constraints**
- Final Devpost is due Sun 10/18 at 10:00 AM. Every feature has to be small, isolated, and safe to leave out.
- Don't change the numbers in DEMO.md: $3,933 → $709, $2,248 saved, day 41 and day 120.
- Admin-only controls go behind `localOnly` (local or `ADMIN_TOKEN`). Phones and judges only ever see `/cart`.
- New saved data goes through `db.ts`.

Priority: **P0** = build first, **P1** = build if P0 lands cleanly, **P2** = only with time to spare.

---

## F1 · Checkpoints and scenes (P0)

*Why:* judges come one after another. Today, starting a round means Reset, then three people pasting links again.
That's slow and can go wrong in front of a judge.

- Dashboard → Demo tools gets **Save checkpoint** and a **Restore** list (name plus time saved).
- Built-in scene **"Cart filed (pre-trial)"**: an empty state plus the three demo links filed (Jaret 17 Pro Max 512,
  Carey 17 Pro 256, Kairui Pixel 10 Pro 256) and Kairui's private "money is tight" note. Loading it takes a round
  straight to the 0:45 mark.
- A checkpoint covers the whole saved state (cart, trial, day, chat, notes, prefs, exhibits, evidence), but **not**
  household setup, claims or welcomes. Restoring never removes real people.
- Restoring **doesn't text anyone**. It updates the dashboard and case file over SSE and adds one activity line,
  "Restored checkpoint X".
- Checkpoints are saved under a new `db.ts` key, `checkpoints`, so they survive restarts. At most 10, oldest dropped first.

*API:* `GET /api/demo/checkpoints`, `POST /api/demo/checkpoints {name}`, `POST /api/demo/checkpoints/:id/restore`,
`POST /api/demo/scene/prefiled`. All admin-only (they sit under the existing `/api/demo` gate).

*Done when:* save, then run the trial and +41 days, then restore puts the dashboard back exactly as it was, with no
texts sent. The scene, followed by Rule now, gives $3,933 → $709. There's a test for the store-level snapshot and restore.

## F2 · Preflight panel (P0)

*Why:* "is everything working?" is currently answered by reading terminal logs and checking each phone by hand.

A **Ready for judges** card at the top of the dashboard with green/amber/red rows:

| Check | Green when |
|---|---|
| Storage | `db.ts` backend is `mongodb` (amber: local files, which is fine on a laptop and risky on a host) |
| Photon | connected (amber: not configured, so you're running on the simulator) |
| Gemini | key configured and the last call worked (amber: fell back to rules; red: billing/quota error seen) |
| Public URL | `PUBLIC_URL` is https and not localhost |
| People | every saved member is linked and welcomed (shows "2/3 welcomed") |
| Cart | empty or at a checkpoint/scene (amber if a trial already ran: "reset before the next judge?") |

- The card's header shows a single **Ready** / **Needs attention** summary. It refreshes over the existing SSE state
  push or every 5 seconds.
- Needs a small record of the last LLM outcome in `agent.ts`: `{ at, model | "rules", ok, error? }`.

*Done when:* every row is driven by real state. Removing `GEMINI_API_KEY` or `MONGODB_URI` turns the matching row
amber after a restart.

## F3 · Show the math (P1)

*Why:* the strongest line for the T-Mobile judges is "the AI never does math." Right now that's a claim. This makes it visible.

- The engine adds `math: { label: string; amount: number }[]` to each device and add-on `Ruling`, built as it
  computes: sticker, storage change, trade-in, live or upcoming promo credit, repair. The final line is
  "Today" or "On day N".
- Rule: `math` amounts add up to `nowCost` (or `heldCost` for WAIT) to the dollar.
- Each ruling card on the case file gets a **Show the math** toggle that reveals a small receipt table, with the
  footer "Computed by engine.ts · not the AI". It's collapsed by default and works on phones.

*Done when:* engine tests check that the `math` total equals the ruling's cost for every ruling in the demo trial
(including the budget and cracked-screen variants), and the case file renders the receipt.

## F4 · Presenter cues and shortcuts (P1)

*Why:* the driver juggles the projector, the script and the timing.

- Dashboard keyboard shortcuts, ignored while typing in a field: **R** Rule now, **1/2/3** for +41 days / +120 days /
  +2 years, **S** load the pre-trial scene, **Shift+R** reset (asks first), **F** case file full screen, **?** shows
  the list.
- A slim **cue strip** along the top shows the next beat from DEMO.md and the numbers to say, based on state:
  empty cart → "Paste the three links"; 3 items, no trial → "Kairui's private DM, then R"; trial at day 0 →
  "Read $3,933 → $709, then 1 (+41 days)"; day ≥ 41 → "+2 years, then Kairui texts the college line". It can be hidden.

*Done when:* each shortcut fires the same endpoint as its button, and the cue changes as the demo moves forward.

## F5 · Join the court with a QR code (P1)

*Why:* "Can I try?" is the best moment in a demo. A QR code makes it take seconds.

- Dashboard and case file show a QR code for the case file (`PUBLIC_URL/cart`) and, when `COURT_NUMBER` is set,
  a second one for `sms:<number>&body=court, what phone should I get?`.
- QR codes are made on the server as SVG (the `qrcode` npm package) at `GET /api/qr?data=…`, limited to the case-file
  URL and the court's `sms:` link so it can't make arbitrary codes.
- The case file only shows the "text the court" QR to an admin. On Photon's free plan a judge's number has to be
  under Users first, so the dashboard shows that reminder next to it.

*Done when:* scanning with a phone opens the case file, or Messages with the court number and the text filled in.

## F6 · Rich link preview for the case file (P2)

*Why:* when the court texts the case-file link, iMessage shows a preview. Today it's a plain link.

- Serve `/cart` through a route that adds `og:title` ("The People v. The Family Cart"), `og:description` (after a
  trial: "Spend today $3,933 → $709 · saved $2,248"; before: "Awaiting the court's ruling") and `og:image` (a static
  1200×630 PNG in `public/`).

*Done when:* the link texted after a ruling shows the title and savings line in the iMessage preview.

## F7 · Replay the verdict (P2)

- A **Replay stamps** button on the dashboard animates the stamps and the count-up again without re-running the
  trial or texting anyone. Useful when a judge walks up mid-demo.

---

## Out of scope
Voice calls, real catalog or account APIs, price-drop watching, splitting costs between roommates, and any change
to how the engine prices things.

## Delivery
- One branch `demo-features`, one PR, one commit per feature, so any of them can be dropped.
- `npm test` and `npm run typecheck` pass. New tests cover F1 (snapshot/restore) and F3 (math adds up).
- A quick manual run in rules mode on `localhost:3100`: scene → Rule now → +41 days → restore checkpoint.
- DEMO.md gets a short "Between judges" section (load scene, check the preflight panel) and the shortcut list.
