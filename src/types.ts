export type Tier = "flagship" | "mid" | "budget";

export interface Phone {
  id: string;
  name: string;
  brand: string;
  tier: Tier;
  prices: Record<string, number>; // storageGB -> price
  camera: number; // 1-5
  gaming: number; // 1-5
  batteryHours: number;
  screenIn: number;
  simple?: boolean;
}

export interface Addon {
  id: string;
  name: string;
  monthly: number;
}

export interface Accessory {
  id: string;
  name: string;
  type: "case" | "screen" | "charger" | "battery" | "earbuds";
  brands: string[]; // phone brands it fits, or ["any"]
  price: number;
  note?: string;
  url?: string; // a store page; without one the court links a shopping search for the name
}

export interface Member {
  id: string;
  name: string;
  role: string;
  age: number;
  handles: string[];
  usage: { camera: number; gaming: number; dataGBPerMonth: number };
  device: {
    model: string;
    ageMonths: number;
    storageGB: number;
    storageUsedGB: number;
    batteryHealth: number;
    installmentsLeft: number;
    monthlyInstallment: number;
    tradeInValue: number;
    screenCracked?: boolean; // set by photo evidence
  };
}

export interface Household {
  name: string;
  plan: string;
  members: Member[];
  accountAddons: (Addon & { usedInLast12Months: boolean })[];
}

export interface Promo {
  id: string;
  name: string;
  startsOnDay: number;
  endsOnDay: number;
  phones: string[];
  requiresTradeIn: boolean;
  credit: number;
}

export interface Offers {
  promos: Promo[];
  familyPlan: { name: string; totalMonthlyByLines: Record<string, number> };
  soloPlans: { name: string; monthly: number; dataGB: number }[];
}

export interface World {
  catalog: { phones: Phone[]; addons: Addon[]; accessories?: Accessory[] };
  household: Household;
  offers: Offers;
}

export interface CartItem {
  id: string;
  kind: "device" | "addon" | "accessory";
  memberId: string;
  phoneId?: string;
  storageGB?: number;
  addonId?: string;
  accessoryId?: string;
  addedBy?: string;
}

export type Stamp = "KEEP" | "SWAP" | "WAIT" | "CUT" | "STAY" | "LEAVE";

export interface Ruling {
  itemId: string; // cart item id, or "account:<addonId>" for account sweeps
  memberId?: string;
  label: string; // what the item was
  stamp: Stamp;
  reasons: string[];
  originalCost: number; // what they were about to pay (sticker / first-year)
  nowCost: number; // what they pay today after the ruling (0 if held)
  heldCost: number; // what they'll pay later if WAIT
  savings: number;
  holdUntilDay?: number;
  proposed?: { phoneId: string; storageGB: number; label: string };
  witness?: string; // the old phone's statement, for WAIT rulings
  protection?: { verdict: "ADD" | "SKIP" | "OPTIONAL"; monthly: number; reason: string };
  track?: { points: { day: number; price: number }[]; now: number; lowest: { day: number; price: number } };
}

export interface Trial {
  day: number;
  rulings: Ruling[];
  before: number;
  now: number;
  held: number;
  savings: number;
  planned?: number; // everything this cart will cost: bought now + held for later
  budget?: number; // what's left of the family's phone budget (whole plan), if set
  overBudget?: boolean;
}

export interface NestRuling {
  memberId: string;
  stamp: "STAY" | "LEAVE";
  familyLineMonthly: number;
  soloPlan: { name: string; monthly: number };
  monthlySavings: number;
  reasons: string[];
}

export interface Recommendation {
  phoneId: string;
  name: string;
  storageGB: number;
  price: number;
  why: string[];
}
