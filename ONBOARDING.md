# Get Cart Court running in 5 minutes

You need **Node.js 24 LTS** ([nodejs.org](https://nodejs.org)). That's it.

## 1. Install and start (2 min)

```bash
git clone https://github.com/careycc6/DubHacks26.git
cd DubHacks26
npm install
npm run dev
```

Open **http://localhost:3000/sim** and click **▶ Play the argument**. It works right away with no keys,
running in rules mode.

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
4. **Step 4 (so the links it texts open on phones):** in a second terminal run `npm run tunnel` and open
   the `https://…trycloudflare.com` address it prints once.

Skipped step 3? That's fine. If an unknown number texts the court, it asks "Who's texting?", and a reply like "I'm Maya"
links that number for good.

**Good to know about Photon's free plan:**
- Each person chats with the court one-on-one. All of those chats share one family cart.
- Group chats need Photon's paid dedicated line.
- Only numbers added under **Users** can text the court.
- If your texts aren't arriving, iMessage may be sending from your email instead of your number. Open **debug.photon.codes** on your iPhone to see which handle it uses, and add that one.

## Things to try

| Say or do | What happens |
|---|---|
| Paste a store link | 📎 Filed into the family cart |
| "court, what phone should Grandma get?" | Top 3 picks for how she uses a phone |
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
