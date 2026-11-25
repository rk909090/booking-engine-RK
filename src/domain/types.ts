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
  /** Gradient used as the image placeholder until real photography exists. */
  palette?: [string, string];
};

export type PropertyContent = {
  tagline?: LocalizedText;
  description?: LocalizedText;
  location?: LocalizedText;
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

/** Price breakdown frozen onto a reservation when it is created. */
export type PriceSnapshot = {
  nights: Array<{ date: string; rate: number; season: string | null }>;
  /** The nights' price before any discount. */
  subtotal: number;
  /** Discount on the nights' price; service and tax are charged on what remains. */
  discount?: number;
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
