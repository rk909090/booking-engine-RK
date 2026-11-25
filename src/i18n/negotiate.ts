import { defaultLocale, hasLocale, type Locale } from "./config";

/** Legacy tag some older systems still send for Indonesian. */
const aliases: Record<string, Locale> = { in: "id" };

/**
 * Picks the best supported locale from an Accept-Language header.
 * Only the primary subtag is compared ("id-ID" matches "id").
 */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return defaultLocale;

  const ranked = acceptLanguage
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";");
      const qParam = params.find((p) => p.trim().startsWith("q="));
      const q = qParam ? Number(qParam.trim().slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((entry) => entry.tag && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);

  for (const { tag } of ranked) {
    const primary = tag.split("-")[0];
    const candidate = aliases[primary] ?? primary;
    if (hasLocale(candidate)) return candidate;
  }
  return defaultLocale;
}
