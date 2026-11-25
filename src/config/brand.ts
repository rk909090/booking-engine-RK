/**
 * Brand identity lives here, not scattered through components, so a later
 * move to multi-tenant (one brand per tenant) is a data migration rather
 * than a rewrite. See docs/02-PLAN-PENGEMBANGAN.md, section 3.
 *
 * The name below is a placeholder taken from the development domain
 * (be.attarahospitality.com). Replace it once the brand is confirmed.
 */
export const brand = {
  name: "Attara Hospitality",
  shortName: "Attara",
  /** Bali runs on WITA (UTC+8). */
  timezone: "Asia/Makassar",
  currency: "IDR",
  /** Prefix of guest-facing booking codes, e.g. ATR-7K3Q9MXD. */
  bookingPrefix: "ATR",
} as const;
