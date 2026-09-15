import type { HallLayout, Seat, SeatClass } from "@shared/types";

export interface SeatRow {
  row: string;
  seatClass: SeatClass;
  /** Seat groups split by aisles, so the UI can render walkways. */
  groups: Seat[][];
}

/** Groups a flat seat list into rows, splitting each row at the aisles. */
export function groupSeatsByRow(seats: Seat[], layout: HallLayout): SeatRow[] {
  const rows = new Map<string, Seat[]>();
  for (const seat of seats) {
    const list = rows.get(seat.row) ?? [];
    list.push(seat);
    rows.set(seat.row, list);
  }

  const aisleAfter = new Set(layout.aislesAfter);

  return [...rows.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([row, rowSeats]) => {
      rowSeats.sort((a, b) => a.number - b.number);
      const groups: Seat[][] = [[]];
      for (const seat of rowSeats) {
        groups[groups.length - 1]!.push(seat);
        if (aisleAfter.has(seat.number)) groups.push([]);
      }
      return {
        row,
        seatClass: layout.classesByRow[row] ?? "standard",
        groups: groups.filter((group) => group.length > 0),
      };
    });
}

/** Stable ordering that matches the visual layout (A1, A2, … H12). */
export function sortSeatLabels(labels: string[]): string[] {
  return [...labels].sort((a, b) => {
    const rowA = a.replace(/\d/g, "");
    const rowB = b.replace(/\d/g, "");
    if (rowA !== rowB) return rowA.localeCompare(rowB);
    return Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, ""));
  });
}

export function seatStatusLabel(seat: Seat): string {
  switch (seat.status) {
    case "available":
      return `Seat ${seat.label}, available`;
    case "held":
      return `Seat ${seat.label}, currently held by another customer`;
    case "sold":
      return `Seat ${seat.label}, already sold`;
  }
}
