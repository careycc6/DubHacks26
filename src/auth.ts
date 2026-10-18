// Parent sign-in: "Sign in with Google" / "Sign in with Apple" for whoever runs the court.
// The browser gets an ID token from Google or Apple; we check its signature against their published keys,
// then keep a signed session cookie. No passwords are stored, and the only thing we keep is who may sign in.
//
// Who may sign in:
//  - the first person to sign in to a court nobody has set up yet (they become its owner),
//  - anyone the owner invites by email (Settings → Who can sign in), or listed in OWNER_EMAILS,
//  - and, as before, the computer running the court or a browser that opened the ADMIN_TOKEN link.
import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as verifySig } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { get, put } from "./db.ts";
import { savedMemberIds } from "./data.ts";

export type Provider = "google" | "apple";
export type Account = { provider: Provider; sub: string; email?: string; name?: string; addedAt: string; owner?: boolean };
type Accounts = { accounts: Account[]; invited: string[] };

const SESSION_COOKIE = "cc_session";
const SESSION_DAYS = 30;
const APPLE_ISS = "https://appleid.apple.com";
const GOOGLE_ISS = ["https://accounts.google.com", "accounts.google.com"];
const JWKS = { google: "https://www.googleapis.com/oauth2/v3/certs", apple: "https://appleid.apple.com/auth/keys" };

const load = (): Accounts => get<Accounts>("accounts", { accounts: [], invited: [] });
const save = (a: Accounts) => put("accounts", a);
const envOwners = () => (process.env.OWNER_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

// ---- ID token checks (RS256 JWTs signed with keys from the provider's JWKS endpoint)

type Jwk = { kid?: string; kty: string; n?: string; e?: string; [k: string]: unknown };
const b64url = (s: string) => Buffer.from(s, "base64url");
const keyCache = new Map<string, { at: number; keys: Jwk[] }>();

async function keysFor(provider: Provider, refresh = false) {
  const hit = keyCache.get(provider);
  if (hit && !refresh && Date.now() - hit.at < 3600_000) return hit.keys;
  const r = await fetch(JWKS[provider], { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`couldn't fetch ${provider} keys (${r.status})`);
  const keys = ((await r.json()) as { keys: Jwk[] }).keys;
  keyCache.set(provider, { at: Date.now(), keys });
  return keys;
}

type Claims = { iss: string; aud: string | string[]; sub: string; exp: number; email?: string; email_verified?: boolean | string; name?: string };

/** The token's claims if Google/Apple signed it for our client ID and it hasn't expired; throws otherwise. */
export async function verifyIdToken(provider: Provider, token: string, clientId: string): Promise<Claims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("not a JWT");
  const header = JSON.parse(b64url(parts[0]).toString()) as { alg: string; kid: string };
  if (header.alg !== "RS256") throw new Error(`unexpected alg ${header.alg}`);
  let jwk = (await keysFor(provider)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await keysFor(provider, true)).find((k) => k.kid === header.kid); // keys rotated
  if (!jwk) throw new Error("unknown signing key");
  const ok = verifySig("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: "jwk" } as Parameters<typeof createPublicKey>[0]), b64url(parts[2]));
  if (!ok) throw new Error("bad signature");
  const c = JSON.parse(b64url(parts[1]).toString()) as Claims;
  const issOk = provider === "google" ? GOOGLE_ISS.includes(c.iss) : c.iss === APPLE_ISS;
  if (!issOk) throw new Error("wrong issuer");
  if (!(Array.isArray(c.aud) ? c.aud : [c.aud]).includes(clientId)) throw new Error("token is for another app");
  if (c.exp * 1000 < Date.now() - 60_000) throw new Error("token expired");
  return c;
}

// ---- Session cookie: base64url(JSON) + "." + HMAC

let devSecret: string | undefined;
function secret() {
  const s = process.env.SESSION_SECRET || process.env.ADMIN_TOKEN;
  if (s) return s;
  // Laptop with no secrets set: sessions last until the server restarts.
  return (devSecret ??= randomBytes(32).toString("hex"));
}
const sign = (body: string) => createHmac("sha256", secret()).update(body).digest("base64url");

type Session = { p: Provider; sub: string; email?: string; name?: string; exp: number };

function readSession(req: Request): Session | undefined {
  const raw = (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!raw) return undefined;
  const [body, mac] = decodeURIComponent(raw).split(".");
  if (!body || !mac) return undefined;
  const want = Buffer.from(sign(body));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return undefined;
  const s = JSON.parse(Buffer.from(body, "base64url").toString()) as Session;
  return s.exp > Date.now() ? s : undefined;
}

function setSession(req: Request, res: Response, s: Session | undefined) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  if (!s) {
    res.append("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`);
    return;
  }
  const body = Buffer.from(JSON.stringify(s)).toString("base64url");
  res.append("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(`${body}.${sign(body)}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? "; Secure" : ""}`);
}

/** The signed-in parent, if their session is valid and they still have access. */
export function signedIn(req: Request): Account | undefined {
  const s = readSession(req);
  if (!s) return undefined;
  return load().accounts.find((a) => a.provider === s.p && a.sub === s.sub);
}

// ---- Routes

export function authConfig() {
  const apple = process.env.APPLE_CLIENT_ID;
  return {
    google: process.env.GOOGLE_CLIENT_ID || null,
    apple: apple ? { clientId: apple, redirectURI: process.env.APPLE_REDIRECT_URI || `${(process.env.PUBLIC_URL ?? "").replace(/\/+$/, "")}/login` } : null,
  };
}

/** Where a newly signed-in parent lands: the setup guide until the household is filled in, then the dashboard. */
const landing = () => (savedMemberIds().length ? "/dashboard" : "/welcome");

export function authRouter(isAdmin: (req: Request) => boolean) {
  const r = Router();

  r.get("/api/auth/me", (req, res) => {
    const a = signedIn(req);
    res.json({
      ...authConfig(),
      user: a ? { name: a.name, email: a.email, provider: a.provider, owner: !!a.owner } : null,
      admin: isAdmin(req),
      claimable: load().accounts.length === 0 && savedMemberIds().length === 0,
      next: landing(),
    });
  });

  r.post("/api/auth/:provider", async (req, res) => {
    const provider = req.params.provider as Provider;
    if (provider !== "google" && provider !== "apple") return res.status(404).json({ ok: false });
    const clientId = provider === "google" ? process.env.GOOGLE_CLIENT_ID : process.env.APPLE_CLIENT_ID;
    if (!clientId) return res.json({ ok: false, error: `Sign in with ${provider === "google" ? "Google" : "Apple"} isn't set up on this court yet.` });
    const token = String(req.body?.credential ?? req.body?.id_token ?? "");
    let c: Claims;
    try {
      c = await verifyIdToken(provider, token, clientId);
    } catch (err) {
      console.warn(`[auth] ${provider} sign-in rejected:`, (err as Error).message);
      return res.json({ ok: false, error: "That sign-in didn't check out. Please try again." });
    }
    const verified = c.email_verified === true || c.email_verified === "true";
    const email = verified ? c.email?.toLowerCase() : undefined;
    // Apple sends the name only on the very first sign-in, from the browser, not in the token.
    const appleName = provider === "apple" ? [req.body?.user?.name?.firstName, req.body?.user?.name?.lastName].filter(Boolean).join(" ") : "";
    const name = c.name || appleName || email?.split("@")[0];

    const all = load();
    let account = all.accounts.find((a) => a.provider === provider && a.sub === c.sub);
    let firstTime = false;
    if (!account) {
      const invited = !!email && (all.invited.includes(email) || envOwners().includes(email));
      // A brand-new court (nobody signed in, no family saved) belongs to whoever sets it up first.
      // The person running the court (local / admin link) can always add themselves.
      const claim = all.accounts.length === 0 && (savedMemberIds().length === 0 || isAdmin(req));
      if (!invited && !claim) {
        return res.json({
          ok: false,
          error: `This court already belongs to a family. Ask the parent who set it up to add ${email ?? "your email"} under Settings → Who can sign in.`,
        });
      }
      account = { provider, sub: c.sub, email, name, addedAt: new Date().toISOString(), owner: claim || undefined };
      all.accounts.push(account);
      if (email) all.invited = all.invited.filter((e) => e !== email);
      save(all);
      firstTime = true;
      console.log(`[auth] ${claim ? "owner" : "invited parent"} signed in for the first time: ${email ?? provider}`);
    }
    setSession(req, res, { p: provider, sub: c.sub, email: account.email, name: account.name, exp: Date.now() + SESSION_DAYS * 86400_000 });
    res.json({ ok: true, firstTime, next: firstTime && !savedMemberIds().length ? "/welcome" : typeof req.body?.next === "string" && req.body.next.startsWith("/") && !req.body.next.startsWith("//") ? req.body.next : landing() });
  });

  r.post("/api/auth/logout", (req, res) => {
    setSession(req, res, undefined);
    res.json({ ok: true });
  });

  // ---- Who can sign in (admins only)
  r.get("/api/auth/accounts", (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false });
    const me = signedIn(req);
    const a = load();
    res.json({
      accounts: a.accounts.map((x) => ({ id: `${x.provider}:${x.sub}`, name: x.name, email: x.email, provider: x.provider, owner: !!x.owner, you: x === me || (me && x.sub === me.sub && x.provider === me.provider) })),
      invited: a.invited,
      fromEnv: envOwners(),
    });
  });

  r.post("/api/auth/invite", (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false });
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.json({ ok: false, error: "Enter an email address, like rosa@gmail.com." });
    const a = load();
    if (a.accounts.some((x) => x.email === email)) return res.json({ ok: false, error: `${email} can already sign in.` });
    if (!a.invited.includes(email)) a.invited.push(email);
    save(a);
    res.json({ ok: true, invited: a.invited });
  });

  r.post("/api/auth/remove", (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false });
    const id = String(req.body?.id ?? "");
    const email = String(req.body?.email ?? "").toLowerCase();
    const a = load();
    const me = signedIn(req);
    if (me && id === `${me.provider}:${me.sub}`) return res.json({ ok: false, error: "You can't remove yourself. Sign out instead." });
    a.accounts = a.accounts.filter((x) => `${x.provider}:${x.sub}` !== id);
    if (email) a.invited = a.invited.filter((e) => e !== email);
    save(a);
    res.json({ ok: true });
  });

  return r;
}
