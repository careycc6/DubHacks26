import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { get, put } from "./db.ts";
import type { World } from "./types.ts";

const dataDir = fileURLToPath(new URL("../data/", import.meta.url));
const load = (file: string) => JSON.parse(readFileSync(dataDir + file, "utf8"));

// Real names and phone numbers entered on /setup are saved by db.ts (MongoDB or data/household.local.json), never in git.
export interface HouseholdLocal {
  /** Only people actually entered on /setup are here; the rest of household.json is example data. */
  members: Record<string, { name?: string; handles?: string[]; role?: string; phoneModel?: string; batteryHealth?: number }>;
}

export function loadHouseholdLocal(): HouseholdLocal {
  return get<HouseholdLocal>("household", { members: {} });
}

export function saveHouseholdLocal(local: HouseholdLocal) {
  put("household", local);
}

/** `local: false` gives the pristine example household (tests use this). */
export function loadWorld(opts: { local?: boolean } = {}): World {
  const world: World = {
    catalog: load("catalog.json"),
    household: load("household.json"),
    offers: load("offers.json"),
  };
  const local = opts.local === false ? { members: {} } as HouseholdLocal : loadHouseholdLocal();
  for (const m of world.household.members) {
    const o = local.members[m.id];
    if (o?.name) m.name = o.name;
    if (o?.handles?.length) m.handles = o.handles;
    if (o?.role) m.role = o.role;
    if (o?.phoneModel) m.device.model = o.phoneModel;
    if (o?.batteryHealth) m.device.batteryHealth = o.batteryHealth; // from Settings → Battery → Battery Health
  }
  return world;
}

/** Members someone actually set up on /setup (empty = still the example household). */
export function savedMemberIds(): string[] {
  return Object.keys(loadHouseholdLocal().members);
}
