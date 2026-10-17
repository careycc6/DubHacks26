import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { World } from "./types.ts";

const dataDir = fileURLToPath(new URL("../data/", import.meta.url));
const load = (file: string) => JSON.parse(readFileSync(dataDir + file, "utf8"));

export function loadWorld(): World {
  return {
    catalog: load("catalog.json"),
    household: load("household.json"),
    offers: load("offers.json"),
  };
}
