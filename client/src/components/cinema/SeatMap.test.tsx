import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HALL_LAYOUT } from "@shared/hall";
import { SeatMap } from "./SeatMap";
import { renderWithProviders } from "@/test/renderWithProviders";
import type { Seat, SeatMap as SeatMapData } from "@shared/types";

function buildSeatMap(): SeatMapData {
  const seats: Seat[] = [];
  for (const row of HALL_LAYOUT.rows) {
    for (let number = 1; number <= HALL_LAYOUT.columns; number += 1) {
      const id = `${row}${number}`;
      seats.push({
        id,
        row,
        number,
        label: id,
        seatClass: HALL_LAYOUT.classesByRow[row] ?? "standard",
        status: id === "A1" ? "sold" : id === "A2" ? "held" : "available",
        priceCents: 1500,
      });
    }
  }
  return {
    showtimeId: "st_test",
    hall: "Hall 1",
    layout: HALL_LAYOUT,
    seats,
    capacity: seats.length,
    seatsLeft: seats.filter((seat) => seat.status === "available").length,
  };
}

describe("<SeatMap />", () => {
  it("renders every seat with an accessible label", () => {
    renderWithProviders(
      <SeatMap seatMap={buildSeatMap()} selectedSeatIds={[]} onToggleSeat={() => undefined} />,
    );
    expect(screen.getAllByRole("button", { name: /^Seat [A-H]\d+,/ })).toHaveLength(
      HALL_LAYOUT.rows.length * HALL_LAYOUT.columns,
    );
  });

  it("disables seats that are already taken or held", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    renderWithProviders(<SeatMap seatMap={buildSeatMap()} selectedSeatIds={[]} onToggleSeat={onToggle} />);

    expect(screen.getByRole("button", { name: /^Seat A1,/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Seat A2,/ })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /^Seat A3,/ }));
    expect(onToggle).toHaveBeenCalledWith("A3");
  });

  it("marks selected seats as pressed", () => {
    renderWithProviders(
      <SeatMap seatMap={buildSeatMap()} selectedSeatIds={["C5"]} onToggleSeat={() => undefined} />,
    );
    expect(screen.getByRole("button", { name: /^Seat C5,/ })).toHaveAttribute("aria-pressed", "true");
  });
});
