import { useTranslation } from "react-i18next";
import { MAX_SEATS_PER_BOOKING } from "@shared/pricing";
import type { Seat, SeatMap as SeatMapData } from "@shared/types";
import { groupSeatsByRow } from "@/lib/seats";
import { seatClassLabel } from "@/lib/localize";
import { useAppConfig } from "@/i18n/AppConfigProvider";
import { cn } from "@/lib/cn";

export interface SeatMapProps {
  seatMap: SeatMapData;
  selectedSeatIds: string[];
  onToggleSeat: (seatId: string) => void;
  disabled?: boolean;
  maxSeats?: number;
}

const SEAT_BASE =
  "relative flex size-8 items-center justify-center rounded-md text-[11px] font-semibold transition " +
  "sm:size-9 sm:text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500";

const SEAT_STYLES = {
  available: "bg-ink-600 text-white/80 hover:bg-brand-500 hover:text-ink-950 cursor-pointer",
  selected: "bg-brand-500 text-ink-950 shadow-[0_0_16px_rgba(29,231,130,0.6)] cursor-pointer",
  taken: "cursor-not-allowed bg-ink-700 text-white/25",
  held: "cursor-not-allowed bg-warning/25 text-warning/70",
} as const;

function seatVisualState(seat: Seat, selected: boolean): keyof typeof SEAT_STYLES {
  if (selected) return "selected";
  if (seat.status === "sold") return "taken";
  if (seat.status === "held") return "held";
  return "available";
}

export function SeatMap({
  seatMap,
  selectedSeatIds,
  onToggleSeat,
  disabled = false,
  maxSeats = MAX_SEATS_PER_BOOKING,
}: SeatMapProps) {
  const { t } = useTranslation();
  const { money } = useAppConfig();
  const rows = groupSeatsByRow(seatMap.seats, seatMap.layout);
  const atLimit = selectedSeatIds.length >= maxSeats;

  return (
    <div className="w-full overflow-x-auto pb-2">
      <div className="mx-auto min-w-max">
        {/* Screen */}
        <div className="mb-8">
          <div className="mx-auto h-8 w-[min(560px,90%)] rounded-t-[50%] bg-gradient-to-b from-brand-500/70 to-brand-500/5 blur-[1px]" />
          <p className="mt-1 text-center text-xs uppercase tracking-[0.35em] text-white/55">
            {t("seats.screen")}
          </p>
        </div>

        <div
          className="flex flex-col gap-2"
          role="group"
          aria-label={t("seats.mapAria", {
            hall: seatMap.hall,
            left: seatMap.seatsLeft,
            capacity: seatMap.capacity,
          })}
        >
          {rows.map((row) => (
            <div key={row.row} className="flex items-center gap-2 sm:gap-3">
              <span className="w-5 shrink-0 text-center text-xs font-semibold text-white/40" aria-hidden>
                {row.row}
              </span>
              {row.groups.map((group, groupIndex) => (
                <div key={`${row.row}-${groupIndex}`} className="flex items-center gap-1.5 sm:gap-2">
                  {group.map((seat) => {
                    const isSelected = selectedSeatIds.includes(seat.id);
                    const isTaken = seat.status !== "available" && !isSelected;
                    const state = seatVisualState(seat, isSelected);
                    const blocked = disabled || (isTaken ?? false) || (atLimit && !isSelected);

                    return (
                      <button
                        key={seat.id}
                        type="button"
                        disabled={blocked}
                        aria-pressed={isSelected}
                        aria-label={t("seats.seatAria", {
                          label: seat.label,
                          seatClass: seatClassLabel(seat.seatClass, t),
                          status: t(`seats.${seat.status === "sold" ? "taken" : seat.status}`),
                          price: money(seat.priceCents),
                        })}
                        title={`${seat.label} · ${seatClassLabel(seat.seatClass, t)} · ${money(
                          seat.priceCents,
                        )}`}
                        onClick={() => onToggleSeat(seat.id)}
                        className={cn(SEAT_BASE, SEAT_STYLES[state], blocked && "cursor-not-allowed")}
                      >
                        {seat.number}
                      </button>
                    );
                  })}
                </div>
              ))}
              <span className="w-5 shrink-0 text-center text-xs font-semibold text-white/40" aria-hidden>
                {row.row}
              </span>
            </div>
          ))}
        </div>

        <SeatLegend maxSeats={maxSeats} />
      </div>
    </div>
  );
}

function SeatLegend({ maxSeats }: { maxSeats: number }) {
  const { t } = useTranslation();
  const items: Array<[string, keyof typeof SEAT_STYLES]> = [
    [t("seats.available"), "available"],
    [t("seats.selected"), "selected"],
    [t("seats.taken"), "taken"],
    [t("seats.held"), "held"],
  ];

  return (
    <div className="mt-8 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-white/55">
      {items.map(([label, state]) => (
        <span key={label} className="inline-flex items-center gap-1.5">
          <span className={cn("size-4 rounded-[4px]", SEAT_STYLES[state])} aria-hidden />
          {label}
        </span>
      ))}
      <span className="text-white/50">· {t("seats.upTo", { max: maxSeats })}</span>
    </div>
  );
}
