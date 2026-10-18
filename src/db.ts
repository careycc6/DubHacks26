// What the court remembers between restarts: a tiny key-value store with one entry per thing
// (the cart and rulings, who's in the household, who claimed which number, who got a welcome).
// MONGODB_URI set → MongoDB (survives redeploys, any machine can run the court).
// Otherwise → data/<key>.local.json files (gitignored). CART_COURT_DB=memory saves nothing (tests). Reads come from an in-memory copy loaded at startup,
// so the rest of the app stays synchronous; writes are batched and flushed in the background.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Collection } from "mongodb";

const KEYS = ["household", "claims", "welcomed", "state", "checkpoints", "accounts"] as const;
export type Key = (typeof KEYS)[number];

// CART_COURT_DATA_DIR lets tests use a throwaway folder instead of your real household.
const dataDir = process.env.CART_COURT_DATA_DIR ? process.env.CART_COURT_DATA_DIR.replace(/[\/]?$/, "/") : fileURLToPath(new URL("../data/", import.meta.url));
const fileFor = (key: Key) => `${dataDir}${key}.local.json`;
const readFile = (key: Key): unknown => (existsSync(fileFor(key)) ? JSON.parse(readFileSync(fileFor(key), "utf8")) : undefined);

// Values are stored as JSON strings in Mongo: phone numbers and emails make awkward field names.
type Doc = { _id: string; json: string; updatedAt: Date };
let docs: Collection<Doc> | undefined;
const cache = new Map<Key, unknown>();

async function connect(uri: string) {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, appName: "cart-court" });
  await client.connect();
  const coll = client.db(process.env.MONGODB_DB || "cartcourt").collection<Doc>("kv");
  for (const d of await coll.find().toArray()) cache.set(d._id as Key, JSON.parse(d.json));
  // First run against a fresh database: bring along whatever this computer already had on disk.
  for (const key of KEYS) {
    const local = cache.has(key) ? undefined : readFile(key);
    if (local === undefined) continue;
    cache.set(key, local);
    await coll.replaceOne({ _id: key }, { json: JSON.stringify(local), updatedAt: new Date() }, { upsert: true });
    console.log(`[db] copied data/${key}.local.json into MongoDB`);
  }
  docs = coll;
}

const uri = process.env.MONGODB_URI;
export let backend: "mongodb" | "files" | "memory" = process.env.CART_COURT_DB === "memory" ? "memory" : "files";
if (uri && backend !== "memory") {
  try {
    await connect(uri);
    backend = "mongodb";
  } catch (err) {
    console.error(`[db] couldn't reach MongoDB, saving to local files instead: ${(err as Error).message}`);
  }
}
if (backend === "files") for (const key of KEYS) {
  const v = readFile(key);
  if (v !== undefined) cache.set(key, v);
}
if (backend !== "memory") console.log(`[db] ${backend === "mongodb" ? `MongoDB (${process.env.MONGODB_DB || "cartcourt"})` : "local files in data/"}`);

/** A copy of what's saved under `key`, or `fallback` if nothing is. */
export function get<T>(key: Key, fallback: T): T {
  return cache.has(key) ? structuredClone(cache.get(key) as T) : fallback;
}

const dirty = new Set<Key>();
let timer: NodeJS.Timeout | undefined;
let writing: Promise<void> = Promise.resolve();

/** Save `value` under `key`. Written within a moment; call flush() to wait for it. */
export function put(key: Key, value: unknown) {
  cache.set(key, structuredClone(value));
  if (backend === "memory") return;
  dirty.add(key);
  timer ??= setTimeout(() => void flush(), 250);
}

async function write(key: Key, value: unknown) {
  const json = JSON.stringify(value);
  if (docs) {
    await docs.replaceOne({ _id: key }, { json, updatedAt: new Date() }, { upsert: true });
  } else {
    writeFileSync(fileFor(key) + ".tmp", json);
    renameSync(fileFor(key) + ".tmp", fileFor(key)); // never leave a half-written file behind
  }
}

export function flush(): Promise<void> {
  clearTimeout(timer);
  timer = undefined;
  const keys = [...dirty];
  dirty.clear();
  writing = writing.then(async () => {
    for (const key of keys) {
      try {
        await write(key, cache.get(key));
      } catch (err) {
        console.error(`[db] couldn't save ${key}:`, (err as Error).message);
        dirty.add(key); // try again with the next save
      }
    }
  });
  return writing;
}

// Save everything before the process goes away (Ctrl-C, `node --watch` restarts, a host redeploying).
const beforeExit: (() => void)[] = [];
export const onShutdown = (fn: () => void) => beforeExit.push(fn);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    beforeExit.forEach((fn) => fn());
    await flush();
    process.exit(0);
  });
}

// ---- Serverless (Vercel): several short-lived copies of the court may run, so each request first pulls
// the latest from MongoDB. Modules that keep their own copy (state, claims, welcomes) re-read via onReload.
const reloadHooks: (() => void)[] = [];
export const onReload = (fn: () => void) => reloadHooks.push(fn);

export async function reload() {
  if (!docs) return; // local files: this process is the only writer
  for (const d of await docs.find().toArray()) {
    if (!dirty.has(d._id as Key)) cache.set(d._id as Key, JSON.parse(d.json));
  }
  for (const fn of reloadHooks) fn();
}
