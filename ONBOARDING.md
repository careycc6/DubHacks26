# Get Cart Court running in 5 minutes

You need **Node.js 24 LTS** ([nodejs.org](https://nodejs.org)). That's it.

## 1. Install and start (2 min)

```bash
git clone https://github.com/careycc6/DubHacks26.git
cd DubHacks26
npm install
npm run dev
```

Open **http://localhost:3000**. That's the dashboard: the family's case file, the household, an activity feed,
a **⚖️ Rule now** button and **⚙ Setup** in the top right. It works right away with no keys, in rules mode, using an example family.

## 2. Give the court a voice (1 min, free)

Open **http://localhost:3000/setup**, then in step 1:
1. Click the link to **aistudio.google.com/apikey** and sign in with your Google account.
2. Click **Create API key**, copy it, paste it into the setup page, then click **Save & test**.

You'll see ✓ Works. Now the court chats naturally and reads photos.

> **Quotas and credits.** A new key's free tier is small (about 20 requests per day per model), so Cart Court
> rotates through Flash-Lite and Flash models and falls back to rules mode when they're all busy.
> If you redeem Google credits (e.g. from a Google AI Pro plan), the key's project may switch to **prepaid billing**.
> Make sure the credits land on **that same project** at [ai.studio/projects](https://ai.studio/projects).
> Otherwise every call fails with "prepayment credits are depleted", and the setup page will tell you.

## 3. Put it on your family's phones (optional, 3 min)

On the same **/setup** page:
1. **Step 2:** paste your Photon **Project ID** and **Project Secret** from [app.photon.codes](https://app.photon.codes), then click **Connect**.
2. **Once, in a terminal:** `npx -p @photon-ai/cli photon login` (approve it in your browser). This lets the court add
   your family's numbers under Photon's **Users** list itself. Prefer to do it by hand? Add each number at app.photon.codes → Users.
3. **Step 3, "Your household":** the grey rows are an example family. Type over a row with a real person's name,
   role, current phone and number. Rows you leave blank stay examples and are never saved or texted. Then click **Text everyone**.
   Each person gets "Welcome to the court, [name]! ⚖️" from the court's number. Save it as a contact called "Cart Court".

Hosted court? The case-file links it texts open on phones automatically. Running it on a laptop instead? Run
`npm run tunnel` in a second terminal and open the `https://…trycloudflare.com` address it prints once.

Skipped step 3? That's fine. If an unknown number texts the court, it asks "Who's texting?", and a reply like "I'm Maya"
links that number for good.

**Good to know about Photon's free plan:**
- Each person chats with the court one-on-one. All of those chats share one family cart.
- Group chats need Photon's paid dedicated line. Cart Court is built to work without one (see below).
- Only numbers added under **Users** can text the court.
- If your texts aren't arriving, iMessage may be sending from your email instead of your number. Open **debug.photon.codes** on your iPhone to see which handle it uses, and add that one.

### No group chat? The court runs the house rules itself

Everyone texts the court one-on-one, and it keeps the family in sync:

- **Family feed:** when someone adds, buys or removes something, everyone else gets a one-line update in their own chat.
- **Parents run the cart.** Only people saved as **Parent** (or **Partner**) can clear the cart, set the family budget,
  add, remove or change items, or fix who a purchase was for. When a kid, teen or grandparent adds something, it's a
  **request**: parents get a text and reply **approve** or **deny** ("approve Maya's", "approve all"). Anyone's purchase
  ("bought it for $…") still takes their item off the cart. (A household with no parents, like roommates, lets everyone do it.)
- **Clearing takes two texts:** text `cart clear` (it must say "cart"), then reply **YES** within 2 minutes.
- **Anyone can report a purchase:** "bought my iPhone 17 for $799" or a photo of the receipt. The court confirms who it's
  for ("this is Maya's new phone"), matching the model to whoever has it in the cart. Kids can log their own purchases by text, but logging one as
  someone else's needs a photo of the receipt. If that's wrong, a parent texts
  **"this is for Rosa"** and the court moves it (and puts back anything it took out of the wrong cart).
- **Battery health (optional):** leave it blank if unknown. Anyone can text "battery health 85%" later (iPhone: Settings → Battery →
  Battery Health; Pixel: Settings → Battery → Battery health; Galaxy: Samsung Members → Phone diagnostics). When a battery is
  worn but the phone is otherwise fine, the court also suggests a ~$99 battery replacement as the cheaper option.
- **Accessories:** picks come with a shop link. Add one to the cart, or buy it yourself and text "bought the case for $35"
  (or tap **Bought…** on the dashboard).
- **The family budget** is the money set aside for phones over the whole plan, now and later (it can cover a couple of
  years). The court counts what's bought, what's in the cart, and what's held for later, and picks cheaper fits if it runs over.

## 4. For whoever runs the server: MongoDB Atlas (5 min, free)

Family members never see this. It's for the person hosting the court. Without it, the court saves to `data/*.local.json`
on the machine running it. With MongoDB, the cart, rulings, household and chat survive restarts and can move to a hosted
server (see "Host it" in the README).

1. Sign up at **[mongodb.com/cloud/atlas/register](https://www.mongodb.com/cloud/atlas/register)** (Google sign-in works).
2. **Create a cluster** and choose the **free M0** tier. Any provider or region is fine (pick one near you).
3. **Database Access → Add New Database User**: choose a username and password, and save the password.
4. **Network Access → Add IP Address**: add your current IP. For a hackathon on changing Wi-Fi, `0.0.0.0/0` (anywhere)
   is simplest. Remove it afterwards.
5. **Connect → Drivers → Node.js**: copy the connection string (`mongodb+srv://…`) and replace `<db_password>` with your password.
6. Add it to `.env` as `MONGODB_URI=mongodb+srv://…` (or to your host's environment variables) and restart the server.
   The first start copies over everything already saved on that machine.

Check it at `/healthz`: it should say `"db":"mongodb"`, and the server log prints `[db] MongoDB (cartcourt)`.
If it can't connect, it says why in the log and keeps saving to files. Common causes: a wrong password, an IP not
allowed yet, or a mistyped address.

## 5. Parent sign-in with Google or Apple (optional, 5 min)

On a hosted court (Vercel), parents sign in at **`/login`** instead of using the `?key=ADMIN_TOKEN` link.
The first parent to sign in to a **fresh** court (no family saved yet) becomes its owner and lands on the
**setup guide** (`/welcome`): family, budget, iMessage, welcome texts, co-parent. After that, sign-in goes
straight to the dashboard. Co-parents are added by email under **Settings → Who can sign in** (or in the guide).

**Google** (needed for the button to show):
1. [console.cloud.google.com](https://console.cloud.google.com) → APIs & Services → Credentials → **Create credentials → OAuth client ID** → *Web application*.
2. **Authorized JavaScript origins:** your court's URL (e.g. `https://dub-hacks26.vercel.app`) and `http://localhost:3000`.
3. Copy the client ID into `GOOGLE_CLIENT_ID` (Vercel → Settings → Environment Variables, and `.env` locally).

**Apple** (optional; needs an Apple Developer account):
1. developer.apple.com → Identifiers → **Services IDs** → new ID (e.g. `com.yourname.cartcourt`), enable *Sign in with Apple*.
2. Add your domain and the return URL `https://<your court>/login`.
3. Put the Services ID in `APPLE_CLIENT_ID` (and `APPLE_REDIRECT_URI` if the return URL differs).

Also set `SESSION_SECRET` (any long random string) so sign-ins survive redeploys. `OWNER_EMAILS` (comma-separated)
pre-approves emails. Nothing is stored except who may sign in; Google/Apple tokens are checked against their published keys.

## Things to try

| Say or do | What happens |
|---|---|
| Paste a store link | 📎 Filed into the family cart |
| "court, what phone should Grandma get?" | Asks how she uses the camera and games (1 to 5) the first time, then the top 3 picks |
| Send a photo of a cracked screen or a battery-health screenshot | 🗂️ Exhibit A, and the ruling updates |
| "court, rule" | The cart goes on trial: KEEP / SWAP / WAIT / CUT |
| "court, Maya's leaving for college" | STAY on the family plan or LEAVE |
| DM the court "money's tight" | Rulings tighten, and it never says who asked |

The live case file is at **/cart**. The 3-minute demo script is in **[DEMO.md](DEMO.md)**.

## Make it your household

Everything is plain JSON in `data/`:
- **`household.json`**: people, their phones (age, battery, storage used, payments left, trade-in value) and add-ons.
  Optionally list each person's real phone number in `handles`, so they skip the "who's texting?" question.
- **`catalog.json`**: phones and prices.
- **`offers.json`**: promos (with start and end days) and plan pricing.

All data is synthetic. Don't put real account data in here.
