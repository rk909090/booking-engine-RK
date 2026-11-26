import type { MetadataRoute } from "next";
import { connection } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { locales } from "@/i18n/config";
import { siteIndexable, siteUrl } from "@/lib/site/seo";

/** Public pages in both languages, each with its translations (hreflang). Empty until launch. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  await connection();
  if (!siteIndexable()) return [];
  const base = siteUrl();
  const villas = await getDb()
    .select({ property: schema.properties.slug, type: schema.unitTypes.slug, updatedAt: schema.unitTypes.updatedAt })
    .from(schema.unitTypes)
    .innerJoin(schema.properties, eq(schema.properties.id, schema.unitTypes.propertyId))
    .where(and(eq(schema.unitTypes.isPublished, true), eq(schema.properties.isActive, true)))
    .orderBy(asc(schema.properties.slug), asc(schema.unitTypes.sortOrder));
  const entry = (path: string, priority: number, lastModified?: Date): MetadataRoute.Sitemap =>
    locales.map((lang) => ({
      url: `${base}/${lang}${path}`,
      lastModified,
      priority,
      alternates: { languages: Object.fromEntries(locales.map((l) => [l, `${base}/${l}${path}`])) },
    }));
  return [...entry("", 1), ...entry("/stay", 0.8), ...villas.flatMap((v) => entry(`/villas/${v.property}/${v.type}`, 0.9, v.updatedAt))];
}
