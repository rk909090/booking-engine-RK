import { getDb } from "@/db/client";
import { exportGuestData } from "@/domain/guests";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { guestScope } from "@/lib/ops/guest-access";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Everything held about a guest as JSON, for a data request under UU PDP. Branch managers only; logged. */
export async function GET(_request: Request, { params }: RouteContext<"/api/ops/guests/[id]/export">) {
  const { id } = await params;
  const staff = await requireStaff("id");
  if (!UUID.test(id)) return new Response("Not found", { status: 404 });
  const scope = await guestScope(staff.actor, id);
  if (!scope.visible) return new Response("Not found", { status: 404 });
  if (!scope.propertyIds.some((p) => can(staff.actor, "guest.privacy", p).allowed)) return new Response("Forbidden", { status: 403 });
  const data = await exportGuestData(getDb(), { guestId: id, actor: { type: "staff", id: staff.staffId } });
  if (!data) return new Response("Not found", { status: 404 });
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="guest-data-${id.slice(0, 8)}.json"`,
      "cache-control": "private, no-store",
    },
  });
}
