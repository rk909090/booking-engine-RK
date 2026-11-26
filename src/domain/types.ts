/**
 * Shapes stored in jsonb columns. Kept free of database imports so pure
 * domain code (pricing, policy) can use them.
 */

/**
 * One step of a cancellation policy. Cancelling at least `minDaysBefore`
 * days before check-in costs `chargeBp` basis points of the stay total
 * (10000 = 100%). Tiers are evaluated from the largest minDaysBefore down.
 */
export type CancellationTier = { minDaysBefore: number; chargeBp: number };

/** Sample policy. Replace per property once the real terms are agreed. */
export const SAMPLE_CANCELLATION_TIERS: CancellationTier[] = [
  { minDaysBefore: 14, chargeBp: 0 },
  { minDaysBefore: 7, chargeBp: 5000 },
  { minDaysBefore: 0, chargeBp: 10000 },
];

export type LocalizedText = { id: string; en: string };

export type UnitTypeContent = {
  summary?: LocalizedText;
  description?: LocalizedText;
  /** Items checked when inspecting a villa of this type; a general default is used until set. */
  inspectionChecklist?: string[];
  /** Gradient used as the image placeholder until real photography exists. */
  palette?: [string, string];
};

export type PropertyContent = {
  tagline?: LocalizedText;
  description?: LocalizedText;
  location?: LocalizedText;
  /** Seller details printed on invoices (legal name, address, tax number, contact). */
  invoice?: { legalName?: string; address?: string; taxId?: string; phone?: string; email?: string };
  /** House rules guests agree to at pre-check-in; a general default is used until set. */
  houseRules?: { id: string[]; en: string[] };
};

/** A discount on the nights' price: a share in basis points, or a fixed rupiah amount. */
export type Discount = { kind: "percent"; bp: number } | { kind: "amount"; amount: number };

/** A discount as given to a booking: kept so it can be re-applied when the dates change. */
export type DiscountTerms = Discount & { reason: string; givenBy: string | null; givenAt: string };

/**
 * A booking confirmed by staff before the deposit was paid. The deposit is
 * due by `payBy`; after that the booking is flagged, never cancelled automatically.
 */
export type Guarantee = { reason: string; payBy: string; givenBy: string; givenAt: string };

/**
 * Rate plans (decided with the owner, 26 Nov 2026): the standard rate
 * (deposit, usual cancellation policy), non-refundable (a share off, paid in
 * full, no refund) and breakfast included (a price per guest per night).
 */
export const RATE_PLANS = ["standard", "non_refundable", "breakfast"] as const;
export type RatePlan = (typeof RATE_PLANS)[number];

/** Long-stay discount: stays of at least `minNights` get `bp` off the nights' price. */
export type LongStayTier = { minNights: number; bp: number };

export type OfferKind = "promo" | "early_bird" | "long_stay";

/** A discount a booking qualified for. Only the largest one applies (with a staff discount competing too). */
export type OfferTerms = { kind: OfferKind; discount: Discount; minNights?: number; code?: string; promoCodeId?: string };

/** The plan and offers a booking was priced with, re-applied when its dates change. */
export type PricingTerms = {
  ratePlan: RatePlan;
  /** Non-refundable: share off the nights' price. */
  planBp?: number;
  /** Breakfast plan: price per guest per night, for this many guests. */
  breakfastPerGuest?: number;
  guests?: number;
  offers?: OfferTerms[];
};

/** Price breakdown frozen onto a reservation when it is created. */
export type PriceSnapshot = {
  nights: Array<{ date: string; rate: number; season: string | null }>;
  /** The nights' price before any discount. */
  subtotal: number;
  /** All discounts on the nights' price (plan, plus the one best offer or staff discount); service and tax are charged on what remains. */
  discount?: number;
  ratePlan?: RatePlan;
  /** Part of `discount` from the non-refundable plan. */
  planDiscount?: number;
  /** Part of `discount` from the offer that applied. */
  offer?: { kind: OfferKind; code?: string; amount: number };
  /** Part of `discount` given by staff (when it beat every offer). */
  staffDiscount?: number;
  /** Breakfast plan: added to the nights' price (before service and tax). */
  breakfast?: number;
  service: number;
  tax: number;
  total: number;
  serviceRateBp: number;
  taxRateBp: number;
};

/** Policy terms frozen onto a reservation when it is created. */
export type PolicySnapshot = {
  cancellationTiers: CancellationTier[];
  depositRateBp: number;
  balanceDueDays: number;
};
