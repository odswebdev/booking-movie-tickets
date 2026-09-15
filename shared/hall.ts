import { SEAT_CLASS_PRICES_CENTS } from "./pricing.js";
import type { HallLayout, SeatClass } from "./types.js";

export const HALL_ROWS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;
export const HALL_COLUMNS = 12;
export const HALL_AISLES_AFTER = [4, 9];

const CLASSES_BY_ROW: Record<string, SeatClass> = {
  A: "standard",
  B: "standard",
  C: "standard",
  D: "standard",
  E: "premium",
  F: "premium",
  G: "recliner",
  H: "recliner",
};

export const HALL_LAYOUT: HallLayout = {
  rows: [...HALL_ROWS],
  columns: HALL_COLUMNS,
  aislesAfter: [...HALL_AISLES_AFTER],
  classesByRow: CLASSES_BY_ROW,
};

export function seatClassForRow(row: string): SeatClass {
  return CLASSES_BY_ROW[row] ?? "standard";
}

export function seatPriceCents(row: string): number {
  return SEAT_CLASS_PRICES_CENTS[seatClassForRow(row)];
}

export function seatId(row: string, number: number): string {
  return `${row}${number}`;
}

export function seatLabel(row: string, number: number): string {
  return `${row}${number}`;
}

/** Screen-facing seats are the most expensive, so the hall is priced front-to-back. */
export function cheapestPriceCents(): number {
  return Math.min(...Object.values(SEAT_CLASS_PRICES_CENTS));
}
