export type Tier = "flagship" | "mid" | "budget";

/** A store that sells it: the link, and its price there when known. */
export interface StoreLink {
  store: string; // "Apple", "T-Mobile", "Best Buy", "Amazon"
  url: string;
  price?: number;
}

/** Where a catalog price came from. buy[0] is the maker's own store, whose price is the catalog price. */
export interface Sourced {
  buy?: StoreLink[];
  checked?: string; // "2026-10-18": the day the prices were read off the stores
}

export interface Phone extends Sourced {
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
  /** A carrier's current deal, e.g. T-Mobile's "up to $1,000 off with trade-in on Experience Beyond" (paid as bill credits). */
  carrierDeal?: { store: string; value: number; needs: string; plans: string; url: string };
}

/** Anything else the store sells: laptops, TVs, appliances, furniture, clothes, groceries… */
export interface Product extends Sourced {
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

export interface Addon extends Sourced {
  id: string;
  name: string;
  monthly: number;
}

export interface Accessory extends Sourced {
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
  aka?: string[]; // what the family calls them ("dad", "mom", "grandma")
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
  /** T-Mobile-style deals: only on a certain plan, paid back as monthly bill credits. */
  requiresPlan?: string;
  planExtraMonthly?: number; // what moving to that plan adds to the bill each month
  billCreditMonths?: number; // credit arrives spread over this many monthly bills
}

export interface Offers {
  promos: Promo[];
  familyPlan: { name: string; totalMonthlyByLines: Record<string, number> };
  soloPlans: { name: string; monthly: number; dataGB: number }[];
}

export interface World {
  catalog: { phones: Phone[]; addons: Addon[]; accessories?: Accessory[]; products?: Product[]; categories?: Record<string, Category> };
  household: Household;
  offers: Offers;
}

export interface CartItem {
  id: string;
  kind: "device" | "addon" | "accessory" | "product";
  memberId: string;
  phoneId?: string;
  storageGB?: number;
  addonId?: string;
  accessoryId?: string;
  productId?: string; // catalog product
  variant?: string; // size / config of the product
  /** Not in the catalog: what someone said it is and what it costs ("a $90 air purifier"). */
  custom?: { name: string; price: number; category?: string };
  url?: string; // the store page someone pasted (custom items)
  quantity?: number;
  addedBy?: string;
  overruledBy?: string; // a parent overruled the court: buy it as picked, today
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
  /** Price both ways, so the family can decide whether to hand the old phone down instead. */
  tradeIn?: { device: string; value: number; withTradeIn: number; withoutTradeIn: number };
  /** Set when a parent overruled the court: what the court's own plan would have cost. */
  overruled?: { by: string; courtPlan: string; extra: number };
  /** "Can't Maya just take Dad's phone?": the hand-me-down, priced against trading that phone in. */
  handMeDown?: { from: string; device: string; batteryHealth: number; onDay: number; forgone: number; instead: number; saves: number };
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
