import type { MetadataRoute } from "next";
import { connection } from "next/server";
import { PRIVATE_PATHS, siteIndexable, siteUrl } from "@/lib/site/seo";

/** robots.txt: everything closed until launch (SITE_INDEXABLE=true), then public pages only. */
export default async function robots(): Promise<MetadataRoute.Robots> {
  await connection();
  if (!siteIndexable()) return { rules: { userAgent: "*", disallow: "/" } };
  return { rules: { userAgent: "*", allow: "/", disallow: PRIVATE_PATHS }, sitemap: `${siteUrl()}/sitemap.xml` };
}
