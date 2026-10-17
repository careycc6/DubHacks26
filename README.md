# ⚖️ Cart Court

**An honest phone-shopping assistant that lives in your household's group chat.**
Paste links, send screenshots, argue about phones. Cart Court builds one shared cart, puts it on trial before checkout
(**KEEP / SWAP / WAIT / CUT / STAY**), and texts you back when a held item is actually worth buying.

DubHacks '26 · Title track: **Chef's Choice** · Side tracks: **T-Mobile** (phone shopping), **Photon** (messaging agent), VEYZL (optional third)

> Synthetic data only. No real customer, account, or transaction data is used.

## Run it

```bash
npm install
cp .env.example .env   # all keys optional
npm run dev            # http://localhost:3000/sim  (simulator)  ·  /cart (live case file)
npm test               # pricing engine tests
```

- **No keys at all:** rules-only mode. Try `court, add 17 pro max for maya 512gb`, `court, rule`,
  `court, maya is leaving for college`, `court, what phone for grandma?`
- **`GEMINI_API_KEY`:** full agent with natural language, photo evidence, private DMs. Also enters MLH Best Use of Gemini.
- **`PHOTON_PROJECT_ID` + `PHOTON_PROJECT_SECRET`:** a real iMessage number via Photon 2.0 (Spectrum SDK).
  Put your teammates' numbers in `data/household.json → handles` so the agent knows who's talking.
  Set `PUBLIC_URL` to a tunnel (`npx cloudflared tunnel --url http://localhost:3000`) so the case-file link opens on phones.

## How it works

```
iMessage / SMS (Photon) ─┐
                         ├─► agent.ts ── taste gate (speak only when addressed / sent links or photos; DMs always)
Web simulator (/sim) ────┘      │
                                ├─► Gemini + tools (tools.ts)   ← talks, reads photos, picks tools
                                │        └─► engine.ts           ← ALL numbers: fit, storage, trade-in, promos, WAIT dates, plans
                                └─► store.ts ──SSE──► /cart (live case file) · /checkout (mock store)
```

**Rule that wins the T-Mobile judges: the LLM never does math.** Every price, date, and saving comes from `engine.ts`.

| File | What it does |
|---|---|
| `data/*.json` | Synthetic catalog, household (4 lines), promos, plan pricing. Tune these to shape the demo |
| `src/engine.ts` | `runTrial` (rulings), `advanceTrial` (clock moves, held items re-judged), `leavingNest`, `recommend` |
| `src/tools.ts` | Tool layer + verdict text formatter |
| `src/agent.ts` | Persona/system prompt, when to speak, private "approach the bench" notes, Gemini tool loop, rules fallback |
| `src/channels/photon.ts` | Photon 2.0: inbound stream, group vs DM, image attachments, replies |
| `public/` | `sim.html` (fake iMessage + demo controls), `cart.html` (case file), `checkout.html` (mock store) |

## The 3-minute demo

1. **The argument (group chat).** Maya: "just get me the pro max pleaseee". The court stays silent (taste).
   Family adds phones ("court, add…") or hit **Seed argued cart**. The case file fills live on the projector.
2. **Approach the bench (DM).** Elena privately: "money is tight this month, don't tell the kids."
3. **Trial.** Marco: "court, rule." Verdict: Mom KEEP (dying battery), Dad WAIT 41 days (trade-in promo),
   Maya's Pro Max 512 swapped to iPhone 17 256GB and held until her payments end, unused add-ons CUT.
   **$4,149 → $909 today.**
4. **+41 days.** "Marco, it's time. Ready at $407 instead of $1,099."
5. **+2 years.** "court, maya is leaving for college" → STAY on the family line, saves $240/yr.
   "court, what phone for grandma?" → the grown-up kid is now the one shopping for someone else.
6. **Checkout** → mock store with today's items and held items.

## Build plan (4 people)

| Who | Owns | First milestone |
|---|---|---|
| A | Photon: get a number, confirm the agent can **join a group thread**, wire `handles` | Agent replies in a real group chat |
| B | Agent: Gemini key, prompt tuning, photo evidence ("Exhibit A"), private-notes behavior | Natural-language trial in the simulator |
| C | Case file + checkout design, projector polish, QR code for judges to join | Page judges remember |
| D | Data tuning (`data/*.json`), demo script, Devpost write-up, backup video, VEYZL audit | Demo runs start to finish without help |

**Stretch:** voice call with the verdict (Photon SIP and the ElevenLabs/Retell cookbooks), price-drop alerts on held items, roommate cost-split.

## Hackathon checklist

- [ ] Devpost **draft before Sat 10:30 PM**: team plus Discords, title track, side tracks
- [ ] Read T-Mobile's `UW_Hackathon_Challenge_Brief.docx` and match its mock-data fields and language
- [ ] Record a backup demo video as soon as Photon works
- [ ] Final Devpost **before Sun 10:00 AM** with public GitHub link
