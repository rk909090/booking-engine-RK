import "server-only";
import type { Locale } from "./config";
import type id from "./dictionaries/id.json";

/** Indonesian is the reference shape; scripts/check-i18n.mjs keeps en.json identical in keys. */
export type Dictionary = typeof id;

const loaders: Record<Locale, () => Promise<Dictionary>> = {
  id: () => import("./dictionaries/id.json").then((m) => m.default),
  en: () => import("./dictionaries/en.json").then((m) => m.default),
};

export function getDictionary(locale: Locale): Promise<Dictionary> {
  return loaders[locale]();
}
