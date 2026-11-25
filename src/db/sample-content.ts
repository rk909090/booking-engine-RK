import { and, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";
import type { PropertyContent, UnitTypeContent } from "@/domain/types";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/*
 * Fictional sample content for the development and demo site. Safe to run
 * again: it updates the sample properties and villa types by slug and adds
 * the sample high season only where none exists yet.
 */

const properties: Record<string, PropertyContent> = {
  ubud: {
    tagline: { id: "Paviliun kayu di tepi lembah sungai", en: "Timber pavilions above the river valley" },
    location: { id: "Sayan, Ubud · 75 menit dari bandara", en: "Sayan, Ubud · 75 minutes from the airport" },
    description: {
      id: "Pagi dimulai dengan kabut di atas pepohonan dan suara sungai di bawah. Desa Sayan bisa dicapai dengan berjalan kaki.",
      en: "Mornings begin with mist over the canopy and the river below. Sayan village is a short walk away.",
    },
  },
  canggu: {
    tagline: { id: "Vila kolam renang di antara sawah", en: "Pool villas among the rice fields" },
    location: { id: "Berawa, Canggu · 45 menit dari bandara", en: "Berawa, Canggu · 45 minutes from the airport" },
    description: {
      id: "Sawah di depan, pantai berpasir hitam lima menit bersepeda. Tenang di siang hari, dekat dengan kafe di sore hari.",
      en: "Rice fields in front, a black-sand beach five minutes by bike. Quiet by day, close to the cafés by evening.",
    },
  },
};

const unitTypes: Record<
  string,
  { content: UnitTypeContent; amenities: string[]; minStayNights: number; sortOrder: number; highSeasonRate: number }
> = {
  "river-pavilion": {
    sortOrder: 1,
    minStayNights: 2,
    highSeasonRate: 8_500_000,
    amenities: ["private_pool", "breakfast", "daily_housekeeping", "villa_host", "wifi", "air_conditioning", "outdoor_bath"],
    content: {
      palette: ["#2f5d50", "#c9b48a"],
      summary: { id: "Paviliun satu kamar dengan kolam di tepi lembah.", en: "A one-bedroom pavilion with a pool at the valley's edge." },
      description: {
        id: "Satu paviliun terbuka di bawah atap kayu berukir, kolam renang menghadap lembah, dan bak mandi batu di taman berdinding. Dibuat untuk berdua.",
        en: "One open pavilion under a carved timber roof, a pool facing the valley and a stone bath in a walled garden. Made for two.",
      },
    },
  },
  "canopy-villa": {
    sortOrder: 2,
    minStayNights: 2,
    highSeasonRate: 13_500_000,
    amenities: ["private_pool", "breakfast", "daily_housekeeping", "villa_host", "wifi", "air_conditioning", "yoga_deck"],
    content: {
      palette: ["#24463f", "#8fb09a"],
      summary: { id: "Dua suite setinggi kanopi, dihubungkan jembatan kayu.", en: "Two suites at canopy height, linked by a timber bridge." },
      description: {
        id: "Dua kamar tidur di dua paviliun terpisah, cocok untuk dua pasangan atau keluarga kecil. Dek yoga menghadap hutan.",
        en: "Two bedrooms in separate pavilions, right for two couples or a small family. A yoga deck faces the forest.",
      },
    },
  },
  "ricefield-pool-villa": {
    sortOrder: 1,
    minStayNights: 2,
    highSeasonRate: 11_500_000,
    amenities: ["private_pool", "breakfast", "daily_housekeeping", "villa_host", "wifi", "air_conditioning", "kitchen"],
    content: {
      palette: ["#3d6b4f", "#e0c98f"],
      summary: { id: "Vila dua kamar dengan kolam panjang menghadap sawah.", en: "A two-bedroom villa with a long pool facing the rice fields." },
      description: {
        id: "Ruang tamu terbuka mengalir ke kolam sepanjang 12 meter. Dapur lengkap untuk koki pribadi atau masak sendiri.",
        en: "An open living room flows onto a 12-metre pool. A full kitchen for a private chef or cooking yourself.",
      },
    },
  },
  "family-estate": {
    sortOrder: 2,
    minStayNights: 3,
    highSeasonRate: 32_000_000,
    amenities: ["private_pool", "breakfast", "daily_housekeeping", "villa_host", "wifi", "air_conditioning", "kitchen", "garden"],
    content: {
      palette: ["#1f3d36", "#d29a6a"],
      summary: { id: "Rumah empat kamar dengan taman luas untuk keluarga besar.", en: "A four-bedroom house with a large garden for families." },
      description: {
        id: "Empat kamar tidur bersuite, taman berumput, dan kolam renang dengan bagian dangkal untuk anak-anak.",
        en: "Four en-suite bedrooms, a lawn garden and a pool with a shallow end for children.",
      },
    },
  },
};

/** Sample peak season used in demos: 20 Dec to 5 Jan, minimum 5 nights. */
const HIGH_SEASON = { name: "Puncak / Peak", startDate: "2026-12-20", endDate: "2027-01-05", minStayNights: 5 };

export async function applySampleContent(db: AnyDb) {
  for (const [slug, content] of Object.entries(properties)) {
    await db.update(schema.properties).set({ content, updatedAt: new Date() }).where(eq(schema.properties.slug, slug));
  }
  for (const [slug, t] of Object.entries(unitTypes)) {
    const [type] = await db
      .update(schema.unitTypes)
      .set({
        content: t.content,
        amenities: t.amenities,
        minStayNights: t.minStayNights,
        sortOrder: t.sortOrder,
        updatedAt: new Date(),
      })
      .where(eq(schema.unitTypes.slug, slug))
      .returning({ id: schema.unitTypes.id });
    if (!type) continue;
    const existing = await db
      .select({ id: schema.rateSeasons.id })
      .from(schema.rateSeasons)
      .where(and(eq(schema.rateSeasons.unitTypeId, type.id), eq(schema.rateSeasons.startDate, HIGH_SEASON.startDate)));
    if (existing.length === 0) {
      await db.insert(schema.rateSeasons).values({ ...HIGH_SEASON, unitTypeId: type.id, nightlyRate: t.highSeasonRate });
    }
  }
}
