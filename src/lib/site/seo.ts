import { appUrl } from "@/lib/booking/access";

/*
 * Search engines: the site stays out of search results until launch.
 * Set SITE_INDEXABLE=true in the hosting environment to open it up; the
 * robots meta tag, robots.txt and the sitemap all follow this switch.
 */

export function siteIndexable(): boolean {
  return process.env.SITE_INDEXABLE === "true";
}

/** The public origin, e.g. https://be.attarahospitality.com. */
export function siteUrl(): string {
  return appUrl().replace(/\/$/, "");
}

/** Paths never meant for search results. */
export const PRIVATE_PATHS = ["/api/", "/id/ops", "/en/ops", "/id/book", "/en/book", "/id/booking", "/en/booking", "/id/pay", "/en/pay"];
