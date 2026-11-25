import { describe, expect, it } from "vitest";
import { dragModes, dragTarget, overlapsOnTarget } from "./calendar-drag";

const units = [
  { id: "rvp-1", unitTypeId: "river" },
  { id: "rvp-2", unitTypeId: "river" },
  { id: "cnp-1", unitTypeId: "canopy" },
];
const stay = { code: "ATR-1", unitId: "rvp-1", status: "confirmed", checkIn: "2027-02-10", checkOut: "2027-02-12" };
const drag = (over: Partial<Parameters<typeof dragTarget>[0]>) =>
  dragTarget({ mode: "move", stay, grabDate: "2027-02-11", hover: { unitId: "rvp-1", date: "2027-02-11" }, units, canMove: true, ...over });

describe("calendar drag", () => {
  it("lets confirmed bookings move and resize, guests in house only resize, and nothing for others or without permission", () => {
    expect(dragModes("confirmed", true)).toEqual(["move", "resize"]);
    expect(dragModes("in_house", true)).toEqual(["resize"]);
    expect(dragModes("hold", true)).toEqual([]);
    expect(dragModes("checked_out", true)).toEqual([]);
    expect(dragModes("confirmed", false)).toEqual([]);
  });

  it("moves the whole stay by the days the pointer moved, keeping its length, to the hovered villa", () => {
    expect(drag({ hover: { unitId: "rvp-2", date: "2027-02-14" } })).toEqual({ checkIn: "2027-02-13", checkOut: "2027-02-15", unitId: "rvp-2", issue: null });
    expect(drag({ hover: { unitId: "rvp-1", date: "2027-02-09" } })).toEqual({ checkIn: "2027-02-08", checkOut: "2027-02-10", unitId: "rvp-1", issue: null });
    expect(drag({}).issue).toBe("no_change");
  });

  it("flags drops on another villa type, or another villa without the move permission", () => {
    expect(drag({ hover: { unitId: "cnp-1", date: "2027-02-11" } }).issue).toBe("different_type");
    expect(drag({ hover: { unitId: "rvp-2", date: "2027-02-11" }, canMove: false }).issue).toBe("no_move");
    expect(drag({ hover: { unitId: "rvp-1", date: "2027-02-12" }, canMove: false }).issue).toBeNull();
  });

  it("resizes the check-out to the day after the hovered night, never below one night", () => {
    expect(drag({ mode: "resize", hover: { unitId: "cnp-1", date: "2027-02-14" } })).toEqual({ checkIn: "2027-02-10", checkOut: "2027-02-15", unitId: "rvp-1", issue: null });
    expect(drag({ mode: "resize", hover: { unitId: "rvp-1", date: "2027-02-05" } })).toMatchObject({ checkOut: "2027-02-11", issue: null });
    expect(drag({ mode: "resize", hover: { unitId: "rvp-1", date: "2027-02-11" } }).issue).toBe("no_change");
  });

  it("keeps guests in house in their villa: a move is refused, a resize works", () => {
    const inHouse = { ...stay, status: "in_house" };
    expect(drag({ stay: inHouse, hover: { unitId: "rvp-2", date: "2027-02-11" } }).issue).toBe("not_movable");
    expect(drag({ stay: inHouse, mode: "resize", hover: { unitId: "rvp-1", date: "2027-02-12" } })).toMatchObject({ checkOut: "2027-02-13", issue: null });
  });

  it("hints at bookings and maintenance already on the target, ignoring the booking itself", () => {
    const others = [stay, { code: "ATR-2", unitId: "rvp-2", status: "confirmed", checkIn: "2027-02-12", checkOut: "2027-02-14" }];
    const blocks = [{ unitId: "rvp-1", startDate: "2027-02-20", endDate: "2027-02-22" }];
    expect(overlapsOnTarget({ checkIn: "2027-02-11", checkOut: "2027-02-13", unitId: "rvp-1" }, "ATR-1", others, blocks)).toBe(false);
    expect(overlapsOnTarget({ checkIn: "2027-02-10", checkOut: "2027-02-12", unitId: "rvp-2" }, "ATR-1", others, blocks)).toBe(false);
    expect(overlapsOnTarget({ checkIn: "2027-02-11", checkOut: "2027-02-13", unitId: "rvp-2" }, "ATR-1", others, blocks)).toBe(true);
    expect(overlapsOnTarget({ checkIn: "2027-02-19", checkOut: "2027-02-21", unitId: "rvp-1" }, "ATR-1", others, blocks)).toBe(true);
  });
});
