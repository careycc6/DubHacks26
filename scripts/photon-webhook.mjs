// Point Photon at the hosted court: registers https://<your-app>/api/photon/webhook for this project.
//   node --env-file=.env scripts/photon-webhook.mjs https://your-app.vercel.app      register (prints the signing secret ONCE)
//   node --env-file=.env scripts/photon-webhook.mjs --list                           show registered webhooks
//   node --env-file=.env scripts/photon-webhook.mjs --delete <id>                    remove one
// Uses PHOTON_PROJECT_ID / PHOTON_PROJECT_SECRET. Put the printed secret in Vercel as SPECTRUM_WEBHOOK_SECRET.
const { PHOTON_PROJECT_ID: id, PHOTON_PROJECT_SECRET: secret } = process.env;
if (!id || !secret) throw new Error("Set PHOTON_PROJECT_ID and PHOTON_PROJECT_SECRET (e.g. run with --env-file=.env)");
const base = `https://spectrum.photon.codes/projects/${id}/webhooks/`;
const auth = { Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64") };
const [arg, extra] = process.argv.slice(2);

const call = async (url, init = {}) => {
  const res = await fetch(url, { ...init, headers: { ...auth, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(`Photon said ${res.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  return body;
};

if (!arg || arg === "--list") {
  const r = await call(base);
  const hooks = r.data ?? r;
  console.log(hooks.length ? hooks.map((h) => `${h.id}  ${h.webhookUrl}`).join("\n") : "No webhooks registered.");
} else if (arg === "--delete") {
  await call(`${base}${extra}/`, { method: "DELETE" });
  console.log(`Removed ${extra}.`);
} else {
  const origin = new URL(arg).origin; // exact URL, no trailing slash: Photon treats redirects as failures
  const webhookUrl = `${origin}/api/photon/webhook`;
  const r = await call(base, { method: "POST", body: JSON.stringify({ webhookUrl }) });
  const d = r.data ?? r;
  console.log(`Registered ${d.webhookUrl}`);
  console.log(`\nSPECTRUM_WEBHOOK_SECRET=${d.signingSecret}\n`);
  console.log("Add that line to Vercel → Settings → Environment Variables, then redeploy. Photon shows this secret only once.");
}
