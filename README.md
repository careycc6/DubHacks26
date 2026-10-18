# ⚖️ Cart Court

**An honest phone-shopping assistant that lives in your household's group chat.**
Paste links, send screenshots, argue about phones. Cart Court builds one shared cart, puts it on trial before checkout
(**KEEP / SWAP / WAIT / CUT / STAY**), and texts you back when a held item is actually worth buying.

DubHacks '26 · Title track: **Chef's Choice** · Side tracks: **T-Mobile** (phone shopping), **Photon** (messaging agent), VEYZL (optional third)

> Synthetic data only. No real customer, account, or transaction data is used.

## Run it

**New here? Follow [ONBOARDING.md](ONBOARDING.md): clone, `npm run dev`, then paste your keys at `localhost:3000/setup`.**


```bash
npm install
cp .env.example .env   # all keys optional
npm run dev            # http://localhost:3000 (dashboard)  ·  /setup  ·  /cart (case file phones open)
npm test               # pricing engine tests
```

- **No keys at all:** rules-only mode. Try `court, add 17 pro max for maya 512gb`, `court, rule`,
  `court, maya is leaving for college`, `court, what phone for grandma?`
- **`GEMINI_API_KEY`:** full agent with natural language, photo evidence, private DMs. Also enters MLH Best Use of Gemini.
- **`PHOTON_PROJECT_ID` + `PHOTON_PROJECT_SECRET`:** a real iMessage number via Photon 2.0 (Spectrum SDK).
  Put your teammates' numbers in `data/household.json → handles` so the agent knows who's talking.
  Set `PUBLIC_URL` to a tunnel (`npx cloudflared tunnel --url http://localhost:3000`) so the case-file link opens on phones.
- **`MONGODB_URI`:** saves the cart, rulings, chat and household to MongoDB (a free Atlas M0 cluster is enough).
  Without it, everything is saved to `data/*.local.json` on this computer. Either way, restarts no longer wipe the cart.

## Host it on Vercel (serverless)

On Vercel the court runs as one serverless function (`api/index.mjs`, bundled from `src/vercel.ts`). iMessages arrive
as **Photon webhooks** at `/api/photon/webhook` instead of a stream; each request reloads state from MongoDB and saves
before the function freezes; pages poll every 3 seconds instead of streaming. Locally `npm run build:vercel &&
node scripts/vercel-local.mjs` runs the same bundle in serverless mode on port 3101.

1. **Import the repo:** [vercel.com/new](https://vercel.com/new) → this GitHub repo → Framework preset **Other**.
   `vercel.json` already sets the build (`npm run build:vercel`), static files (`public/`) and routing.
2. **Environment variables** (Settings → Environment Variables, all environments):

   | Name | Value |
   |---|---|
   | `MONGODB_URI` | your Atlas string (**required**: Vercel's disk is read-only) |
   | `MONGODB_DB` | `cartcourt` |
   | `ADMIN_TOKEN` | a long random string (`openssl rand -hex 24`) to unlock the dashboard |
   | `GEMINI_API_KEY`, `GEMINI_MODELS` | as in `.env` |
   | `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET` | as in `.env` |
   | `NODEJS_HELPERS` | `0` (lets Express read the raw webhook body) |
   | `PUBLIC_URL` | `https://<your-app>.vercel.app` (add after the first deploy) |
   | `SPECTRUM_WEBHOOK_SECRET` | from step 4 |

3. **Deploy**, and note the `https://<your-app>.vercel.app` address.
4. **Point Photon at it** (from your laptop, in `cart-court/`):
   ```bash
   node --env-file=.env scripts/photon-webhook.mjs https://<your-app>.vercel.app
   ```
   It prints `SPECTRUM_WEBHOOK_SECRET=…` **once**. Add it (and `PUBLIC_URL`) in Vercel, then **Redeploy**.
5. **Stop the laptop server** (`Ctrl+C` in its terminal). Two courts on one Photon project would double-reply.
6. Open `https://<your-app>.vercel.app/?key=<ADMIN_TOKEN>` once to unlock the dashboard in that browser.
   `https://<your-app>.vercel.app/healthz` should say `"db":"mongodb"`. Text the court and watch the dashboard.

Keys can't be saved from `/setup` on Vercel (read-only disk). Set them as environment variables instead. The household step works.
`scripts/photon-webhook.mjs --list` / `--delete <id>` show or remove registered webhooks.

## Host it as a container

The server is one long-running Node process (the Photon stream stays connected), so host it as a container with
**exactly one instance, always on** (Cloud Run with min and max instances 1 and CPU always allocated, Render, Fly or Railway).

```bash
docker build -t cart-court .
docker run -p 8080:8080 --env-file .env cart-court   # try the image locally first
```

Set these on the host: `MONGODB_URI`, `ADMIN_TOKEN` (`openssl rand -hex 24`), `PUBLIC_URL` (the host's https address),
plus the Gemini and Photon keys. Then open `https://<host>/?key=<ADMIN_TOKEN>` once to unlock the dashboard and `/setup`
in that browser. Everyone else only gets the case file. Check `https://<host>/healthz`: it should say `"db":"mongodb"`.
On first connect, an empty database copies in whatever `data/*.local.json` the server finds, so you can move a
household you set up on a laptop by running it once locally with `MONGODB_URI` set.

## Where prices come from

The price tracker, promos and protection math run on `data/catalog.json` and `data/offers.json`. The data is **synthetic**,
as T-Mobile's challenge requires (no real customer, account or transaction data). The engine isn't tied to one carrier:
point those files at any store's or carrier's catalog and promo feed and every ruling, price drop and saving follows.

## How it works

```
iMessage / SMS (Photon) ─┐
                         ├─► agent.ts ── taste gate (speak only when addressed / sent links or photos; DMs always)
Dashboard + /sim (backup) ┘     │
                                ├─► Gemini + tools (tools.ts)   ← talks, reads photos, picks tools
                                │        └─► engine.ts           ← ALL numbers: fit, storage, trade-in, promos, WAIT dates, plans
                                └─► store.ts ──SSE──► /cart (live case file) · /checkout (mock store)
                                       └─► db.ts ──► MongoDB (MONGODB_URI) or data/*.local.json
```

**Rule that wins the T-Mobile judges: the LLM never does math.** Every price, date, and saving comes from `engine.ts`.

| File | What it does |
|---|---|
| `data/*.json` | Synthetic catalog, household (4 lines), promos, plan pricing. Tune these to shape the demo |
| `src/engine.ts` | `runTrial` (rulings), `advanceTrial` (clock moves, held items re-judged), `leavingNest`, `recommend` |
| `src/tools.ts` | Tool layer + verdict text formatter |
| `src/agent.ts` | Persona/system prompt, when to speak, private "approach the bench" notes, Gemini tool loop, rules fallback |
| `src/db.ts` | Saves state: MongoDB when `MONGODB_URI` is set, otherwise `data/*.local.json`. Loaded once at startup, written in the background |
| `src/channels/photon.ts` | Photon 2.0: inbound stream, group vs DM, image attachments, replies |
| `public/` | `sim.html` (fake iMessage + demo controls), `cart.html` (case file), `checkout.html` (mock store) |

## The 3-minute demo

Full script with lines, clicks, numbers, judge Q&A and fallbacks: **[DEMO.md](DEMO.md)**.
Short version: **▶ Play the argument**, Mom privately DMs "money is tight", then "court, rule" (**$3,933 → $709 today**),
**+41 days** (Dad's phone is ready, $692 cheaper), **+2 years** (Maya leaves for college, STAY saves $240/yr, then a phone for Grandma).

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
