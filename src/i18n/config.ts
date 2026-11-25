export const locales = ["id", "en"] as const;
export type Locale = (typeof locales)[number];

/** Used when the browser states no supported language (most foreign guests). */
export const defaultLocale: Locale = "en";

/** Cookie that remembers an explicit language choice. */
export const localeCookie = "LOCALE";

export function hasLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}
