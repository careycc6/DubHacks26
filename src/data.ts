import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { World } from "./types.ts";

const dataDir = fileURLToPath(new URL("../data/", import.meta.url));
const load = (file: string) => JSON.parse(readFileSync(dataDir + file, "utf8"));

// Real names and phone numbers entered on /setup live here, never in git.
const localFile = dataDir + "household.local.json";
export interface HouseholdLocal {
  members: Record<string, { name?: string; handles?: string[] }>;
}

export function loadHouseholdLocal(): HouseholdLocal {
  return existsSync(localFile) ? JSON.parse(readFileSync(localFile, "utf8")) : { members: {} };
}

export function saveHouseholdLocal(local: HouseholdLocal) {
  writeFileSync(localFile, JSON.stringify(local, null, 2));
}

export function loadWorld(): World {
  const world: World = {
    catalog: load("catalog.json"),
    household: load("household.json"),
    offers: load("offers.json"),
  };
  const local = loadHouseholdLocal();
  for (const m of world.household.members) {
    const o = local.members[m.id];
    if (o?.name) m.name = o.name;
    if (o?.handles?.length) m.handles = o.handles;
  }
  return world;
}
