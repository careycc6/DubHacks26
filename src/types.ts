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

/** Anything else the store sells: laptops, TVs, appliances, furniture, clothes, groceries… */
export interface Product {
  id: string;
  name: string;
  brand: string;
  category: string; // key into catalog.categories
  tier: Tier;
  prices: Record<string, number>; // variant ("13in", "65in", "M", "std") -> price
  rating: number; // 1-5, how well it does its job
}

/** How the court thinks about a kind of product. */
export interface Category {
  label: string; // "laptop"
  words: string[]; // what people call it in chat: "laptop", "macbook", "notebook"
  lifespanMonths: number; // a working one younger than this doesn't need replacing yet
  fragile?: boolean; // protection plans are worth considering
}

/** Something a member (or the whole household) already owns. Lets the court say "the old one still works". */
export interface Owned {
  id: string;
  memberId?: string; // undefined = shared by the household
  category: string;
  name: string;
  ageMonths: number;
  broken?: boolean;
  tradeInValue?: number;
}

export interface Addon {
  id: string;
  name: string;
  monthly: number;
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
  owned?: Owned[];
}

export interface Promo {
  id: string;
  name: string;
  startsOnDay: number;
  endsOnDay: number;
  phones?: string[]; // phone ids
  products?: string[]; // product ids
  categories?: string[]; // whole categories ("tv"), including items not in the catalog
  requiresTradeIn: boolean;
  credit?: number; // flat USD off
  percentOff?: number; // or a percentage off the sticker
}

export interface Offers {
  promos: Promo[];
  familyPlan: { name: string; totalMonthlyByLines: Record<string, number> };
  soloPlans: { name: string; monthly: number; dataGB: number }[];
}

export interface World {
  catalog: { phones: Phone[]; addons: Addon[]; products?: Product[]; categories?: Record<string, Category> };
  household: Household;
  offers: Offers;
}

export interface CartItem {
  id: string;
  kind: "device" | "addon" | "product";
  memberId: string;
  phoneId?: string;
  storageGB?: number;
  addonId?: string;
  productId?: string; // catalog product
  variant?: string; // size / config of the product
  /** Not in the catalog: what someone said it is and what it costs ("a $90 air purifier"). */
  custom?: { name: string; price: number; category?: string };
  quantity?: number;
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
  proposed?: { phoneId?: string; storageGB?: number; productId?: string; variant?: string; label: string };
  witness?: string; // the old phone's (or old TV's, old vacuum's…) statement, for WAIT rulings
  witnessOf?: string; // "Maya's current phone", "the household's TV"
  urgent?: boolean; // what it replaces is broken or failing: never held for budget
  // The engine's receipt: lines that add up to nowCost (heldCost for WAIT), so the case file can show its work.
  math?: { label: string; amount: number }[];
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
  budget?: number; // the family's budget for today, if set
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
