import { addDays, diffDays } from "./dates";

/*
 * What a drag on the calendar (tape chart) asks for. Pure, so the browser can
 * show the target as the pointer moves; the server still previews and checks
 * every change (domain/modify.ts) before anything is saved.
 *
 * - "move": the whole bar, to other dates and/or another villa of the same type.
 * - "resize": the right edge, to change the check-out date only.
 */

export type DragMode = "move" | "resize";

export type DragStay = { code: string; unitId: string; status: string; checkIn: string; checkOut: string };
export type DragUnit = { id: string; unitTypeId: string };

export type DragIssue = "different_type" | "in_house_unit" | "no_move" | "not_movable" | "no_change";

export type DragTarget = { checkIn: string; checkOut: string; unitId: string; issue: DragIssue | null };

/** Which drags a booking allows: confirmed bookings move and resize, guests in house only extend or shorten. */
export function dragModes(status: string, canModify: boolean): DragMode[] {
  if (!canModify) return [];
  if (status === "confirmed") return ["move", "resize"];
  if (status === "in_house") return ["resize"];
  return [];
}

/**
 * The stay a drag would produce.
 * @param grabDate the day under the pointer when the drag started
 * @param hover the cell under the pointer now
 */
export function dragTarget(input: {
  mode: DragMode;
  stay: DragStay;
  grabDate: string;
  hover: { unitId: string; date: string };
  units: DragUnit[];
  canMove: boolean;
}): DragTarget {
  const { mode, stay, hover } = input;
  if (!dragModes(stay.status, true).includes(mode)) {
    return { checkIn: stay.checkIn, checkOut: stay.checkOut, unitId: stay.unitId, issue: "not_movable" };
  }

  if (mode === "resize") {
    // The hovered day becomes the last night; at least one night.
    const lastNight = hover.date < stay.checkIn ? stay.checkIn : hover.date;
    const checkOut = addDays(lastNight, 1);
    return { checkIn: stay.checkIn, checkOut, unitId: stay.unitId, issue: checkOut === stay.checkOut ? "no_change" : null };
  }

  const shift = diffDays(input.grabDate, hover.date);
  const target = { checkIn: addDays(stay.checkIn, shift), checkOut: addDays(stay.checkOut, shift), unitId: hover.unitId };
  const typeOf = (id: string) => input.units.find((u) => u.id === id)?.unitTypeId;
  let issue: DragIssue | null = null;
  if (target.unitId !== stay.unitId) {
    if (typeOf(target.unitId) !== typeOf(stay.unitId)) issue = "different_type";
    else if (!input.canMove) issue = "no_move";
  } else if (shift === 0) {
    issue = "no_change";
  }
  return { ...target, issue };
}

/** Bookings or maintenance blocks already on the target villa for the target dates (a hint; the server decides). */
export function overlapsOnTarget(
  target: { checkIn: string; checkOut: string; unitId: string },
  self: string,
  stays: DragStay[],
  blocks: Array<{ unitId: string; startDate: string; endDate: string }>,
): boolean {
  const hits = (start: string, end: string) => start < target.checkOut && end > target.checkIn;
  return (
    stays.some((s) => s.code !== self && s.unitId === target.unitId && s.status !== "cancelled" && hits(s.checkIn, s.checkOut)) ||
    blocks.some((b) => b.unitId === target.unitId && hits(b.startDate, b.endDate))
  );
}
