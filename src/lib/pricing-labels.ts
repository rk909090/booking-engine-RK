import type { OfferKind } from "@/domain/types";
import { format } from "@/i18n/format";
import type { Dictionary } from "@/i18n/get-dictionary";

/** Name of a discount offer for guests and staff: "Promo BALI10", "Early-bird discount", ... */
export function offerLabel(t: Dictionary["pricing"], offer: { kind: OfferKind | string; code?: string }): string {
  if (offer.kind === "promo") return format(t.offers.promo, { code: offer.code ?? "" });
  return (t.offers as Record<string, string>)[offer.kind] ?? t.staffDiscount;
}
