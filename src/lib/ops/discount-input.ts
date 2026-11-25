import type { Discount } from "@/domain/types";

/**
 * Reads a discount typed by staff: "10" or "7,5" percent, or a rupiah amount
 * such as "500.000". Returns null when nothing was entered. Validity and
 * limits are checked by the domain.
 */
export function parseDiscountInput(kind: string, value: string): Discount | null {
  if (kind !== "percent" && kind !== "amount") return null;
  if (kind === "amount") {
    const digits = value.replace(/[^\d]/g, "");
    return digits ? { kind: "amount", amount: Number(digits) } : null;
  }
  const cleaned = value.replace(/[^\d.,]/g, "").replace(",", ".");
  if (!cleaned) return null;
  const percent = Number(cleaned);
  return { kind: "percent", bp: Number.isFinite(percent) ? Math.round(percent * 100) : NaN };
}
