import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Small, fictional sample portfolio for development and the demo
 * environment. Names are our own; nothing here is real guest data.
 */
const sample = [
  {
    slug: "ubud",
    name: "Ubud",
    types: [
      { slug: "river-pavilion", name: "River Pavilion", bedrooms: 1, maxGuests: 2, baseRate: 6_500_000, code: "UBD-RVP", count: 3 },
      { slug: "canopy-villa", name: "Canopy Villa", bedrooms: 2, maxGuests: 4, baseRate: 10_500_000, code: "UBD-CNP", count: 2 },
    ],
  },
  {
    slug: "canggu",
    name: "Canggu",
    types: [
      { slug: "ricefield-pool-villa", name: "Ricefield Pool Villa", bedrooms: 2, maxGuests: 4, baseRate: 9_000_000, code: "CGU-RPV", count: 3 },
      { slug: "family-estate", name: "Family Estate", bedrooms: 4, maxGuests: 8, baseRate: 24_000_000, code: "CGU-FME", count: 1 },
    ],
  },
] as const;

/** Inserts the sample portfolio. Expects an empty database. */
export async function seedSampleData(db: AnyDb) {
  await db.transaction(async (tx) => {
    for (const p of sample) {
      const [property] = await tx
        .insert(schema.properties)
        .values({ slug: p.slug, name: p.name })
        .returning();
      for (const t of p.types) {
        const [type] = await tx
          .insert(schema.unitTypes)
          .values({
            propertyId: property.id,
            slug: t.slug,
            name: t.name,
            bedrooms: t.bedrooms,
            maxGuests: t.maxGuests,
            baseRate: t.baseRate,
          })
          .returning();
        await tx.insert(schema.units).values(
          Array.from({ length: t.count }, (_, i) => {
            const n = String(i + 1).padStart(2, "0");
            return {
              propertyId: property.id,
              unitTypeId: type.id,
              code: `${t.code}-${n}`,
              name: `${t.name} ${n}`,
            };
          }),
        );
      }
    }
  });
}
