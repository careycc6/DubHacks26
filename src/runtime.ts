// Where the court is running, and how background work survives there.
//
// Laptop / container (`npm run dev`, Docker): one long-running process. Timers and fire-and-forget
// promises just run, and the Photon stream stays open.
// Vercel (serverless): each request may land on a fresh, short-lived function that freezes as soon as
// the response is sent. So background work is collected here and kept alive with Vercel's waitUntil(),
// and state is re-read from MongoDB at the start of a request and saved before the function freezes.

export const serverless = !!process.env.VERCEL;

const pending = new Set<Promise<unknown>>();

/** Run `work` without holding up the response, but make sure it finishes (even on Vercel). */
export function background(work: Promise<unknown>) {
  const p = work.catch((err) => console.error("[background]", err));
  pending.add(p);
  p.finally(() => pending.delete(p));
}

/** Like setTimeout, but on Vercel it runs right away as tracked background work. */
export function later(fn: () => Promise<unknown> | unknown, ms: number) {
  if (serverless) background(Promise.resolve().then(fn));
  else setTimeout(() => void Promise.resolve().then(fn).catch((err) => console.error("[later]", err)), ms);
}

/** Wait until every piece of background work (including work started by other work) is done. */
export async function settle() {
  // Webhook handlers are dispatched a moment after the response is computed: give them a beat to register.
  await new Promise((r) => setTimeout(r, 50));
  while (pending.size) await Promise.allSettled([...pending]);
}

let waitUntilFn: ((p: Promise<unknown>) => void) | undefined;

/** Keep the Vercel function alive until `p` settles (no-op off Vercel, where the process stays up anyway). */
export async function keepAlive(p: Promise<unknown>) {
  if (!serverless) return;
  if (!waitUntilFn) {
    try {
      ({ waitUntil: waitUntilFn } = await import("@vercel/functions"));
    } catch {
      waitUntilFn = () => {};
    }
  }
  waitUntilFn!(p);
}
