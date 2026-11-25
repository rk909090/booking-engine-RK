import "server-only";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";

/** Active properties for menus and the home page. */
export async function listProperties() {
  return getDb()
    .select({
      id: schema.properties.id,
      slug: schema.properties.slug,
      name: schema.properties.name,
      content: schema.properties.content,
    })
    .from(schema.properties)
    .where(eq(schema.properties.isActive, true))
    .orderBy(asc(schema.properties.name));
}

/** One published villa type with its property, unit count and seasons. */
export async function getVilla(propertySlug: string, typeSlug: string) {
  const db = getDb();
  const [row] = await db
    .select({ type: schema.unitTypes, property: schema.properties })
    .from(schema.unitTypes)
    .innerJoin(schema.properties, eq(schema.properties.id, schema.unitTypes.propertyId))
    .where(
      and(
        eq(schema.properties.slug, propertySlug),
        eq(schema.unitTypes.slug, typeSlug),
        eq(schema.unitTypes.isPublished, true),
        eq(schema.properties.isActive, true),
      ),
    )
    .limit(1);
  if (!row) return null;
  const [[units], seasons] = await Promise.all([
    db
      .select({ n: count() })
      .from(schema.units)
      .where(and(eq(schema.units.unitTypeId, row.type.id), eq(schema.units.isActive, true))),
    db
      .select()
      .from(schema.rateSeasons)
      .where(eq(schema.rateSeasons.unitTypeId, row.type.id))
      .orderBy(asc(schema.rateSeasons.startDate)),
  ]);
  return { ...row, unitCount: units.n, seasons };
}

export async function getUnitTypeById(unitTypeId: string) {
  const [row] = await getDb()
    .select({ type: schema.unitTypes, property: schema.properties })
    .from(schema.unitTypes)
    .innerJoin(schema.properties, eq(schema.properties.id, schema.unitTypes.propertyId))
    .where(eq(schema.unitTypes.id, unitTypeId))
    .limit(1);
  return row ?? null;
}

/** Latest checkout link for a booking still waiting for payment. */
export async function latestCheckoutUrl(reservationId: string): Promise<string | null> {
  const [payment] = await getDb()
    .select({ url: schema.payments.checkoutUrl })
    .from(schema.payments)
    .where(and(eq(schema.payments.reservationId, reservationId), eq(schema.payments.status, "pending")))
    .orderBy(desc(schema.payments.createdAt))
    .limit(1);
  return payment?.url ?? null;
}
