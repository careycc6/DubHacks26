// Parent sign-in: ID-token checks and who may sign in, with a local key standing in for Google's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.CART_COURT_DATA_DIR = mkdtempSync(join(tmpdir(), "cart-court-auth-"));
for (const k of ["MONGODB_URI", "OWNER_EMAILS", "APPLE_CLIENT_ID"]) delete process.env[k];
process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
process.env.SESSION_SECRET = "test-secret";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) =>
  String(url).includes("googleapis.com/oauth2/v3/certs") ? new Response(JSON.stringify({ keys: [jwk] })) : realFetch(url, init)) as typeof fetch;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function idToken(claims: Record<string, unknown>) {
  const body = `${b64({ alg: "RS256", kid: "k1", typ: "JWT" })}.${b64({
    iss: "https://accounts.google.com", aud: process.env.GOOGLE_CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 600, email_verified: true, ...claims,
  })}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(privateKey).toString("base64url")}`;
}

const { verifyIdToken, authRouter } = await import("../src/auth.ts");
const express = (await import("express")).default;
const app = express();
app.use(express.json());
app.use(authRouter(() => false));
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => server.close());

const signIn = (token: string) =>
  realFetch(`${base}/api/auth/google`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential: token }) });

test("a token Google signed for this app is accepted", async () => {
  const c = await verifyIdToken("google", idToken({ sub: "1", email: "a@x.com" }), process.env.GOOGLE_CLIENT_ID!);
  assert.equal(c.sub, "1");
});

test("tokens for another app, expired, or tampered with are rejected", async () => {
  const id = process.env.GOOGLE_CLIENT_ID!;
  await assert.rejects(verifyIdToken("google", idToken({ sub: "1", aud: "someone-else" }), id), /another app/);
  await assert.rejects(verifyIdToken("google", idToken({ sub: "1", exp: 1000 }), id), /expired/);
  const [h, , s] = idToken({ sub: "1" }).split(".");
  await assert.rejects(verifyIdToken("google", `${h}.${b64({ sub: "evil", aud: id, iss: "https://accounts.google.com", exp: 9e9 })}.${s}`, id), /signature/);
});

test("the first parent claims a new court; strangers can't; invited co-parents can", async () => {
  const owner = await signIn(idToken({ sub: "owner", email: "mom@x.com", name: "Elena R" }));
  const ob = await owner.json();
  assert.equal(ob.ok, true);
  assert.equal(ob.next, "/welcome"); // nothing set up yet: the guide
  const cookie = owner.headers.get("set-cookie")!.split(";")[0];

  const me = await (await realFetch(`${base}/api/auth/me`, { headers: { cookie } })).json();
  assert.equal(me.user.email, "mom@x.com");
  assert.equal(me.user.owner, true);

  const stranger = await (await signIn(idToken({ sub: "stranger", email: "who@x.com" }))).json();
  assert.equal(stranger.ok, false);
  assert.match(stranger.error, /already belongs/);

  // The owner invites a co-parent by email (isAdmin is false in this test app, so go through the store).
  const { put, get } = await import("../src/db.ts");
  const a = get<{ accounts: unknown[]; invited: string[] }>("accounts", { accounts: [], invited: [] });
  put("accounts", { ...a, invited: ["dad@x.com"] });
  const dad = await (await signIn(idToken({ sub: "dad", email: "DAD@x.com" }))).json();
  assert.equal(dad.ok, true);
});

test("a forged session cookie is ignored", async () => {
  const fake = Buffer.from(JSON.stringify({ p: "google", sub: "owner", exp: 9e15 })).toString("base64url");
  const me = await (await realFetch(`${base}/api/auth/me`, { headers: { cookie: `cc_session=${fake}.nope` } })).json();
  assert.equal(me.user, null);
});
