import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import type { Actor } from "@/lib/authz/permissions";

/**
 * Guest profiles are shared across properties; staff see a guest who has a
 * booking at one of their properties (directors see all). Returns the
 * properties of the guest's bookings this actor may act for.
 */
export async function guestScope(actor: Actor, guestId: string): Promise<{ visible: boolean; propertyIds: string[] }> {
  const rows = await getDb()
    .selectDistinct({ propertyId: schema.reservations.propertyId })
    .from(schema.reservations)
    .where(and(eq(schema.reservations.guestId, guestId), actor.role === "director" ? undefined : inArray(schema.reservations.propertyId, actor.propertyIds.length ? [...actor.propertyIds] : ["00000000-0000-0000-0000-000000000000"])));
  return { visible: actor.isActive && rows.length > 0, propertyIds: rows.map((r) => r.propertyId) };
}
