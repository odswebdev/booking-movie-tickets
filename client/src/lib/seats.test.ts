import { describe, expect, it } from "vitest";
import { HALL_LAYOUT } from "@shared/hall";
import { groupSeatsByRow, sortSeatLabels } from "./seats";
import type { Seat } from "@shared/types";

function seat(row: string, number: number): Seat {
  return {
    id: `${row}${number}`,
    row,
    number,
    label: `${row}${number}`,
    seatClass: HALL_LAYOUT.classesByRow[row] ?? "standard",
    status: "available",
    priceCents: 1500,
  };
}

const seats = [seat("B", 2), seat("A", 1), seat("A", 12), seat("B", 1)];

describe("groupSeatsByRow", () => {
  it("sorts rows alphabetically and seats numerically", () => {
    const rows = groupSeatsByRow(seats, HALL_LAYOUT);
    expect(rows.map((row) => row.row)).toEqual(["A", "B"]);
    expect(rows[0]?.groups.flat().map((s) => s.label)).toEqual(["A1", "A12"]);
  });

  it("splits rows at the aisles defined by the hall layout", () => {
    const row = groupSeatsByRow(
      Array.from({ length: HALL_LAYOUT.columns }, (_, index) => seat("A", index + 1)),
      HALL_LAYOUT,
    )[0];
    expect(row?.groups.map((group) => group.length)).toEqual([4, 5, 3]);
    expect(row?.seatClass).toBe("standard");
  });
});

describe("sortSeatLabels", () => {
  it("orders seats the way they appear in the hall", () => {
    expect(sortSeatLabels(["H2", "A10", "A2", "B1"])).toEqual(["A2", "A10", "B1", "H2"]);
  });
});
