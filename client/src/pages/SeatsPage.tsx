import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ArrowLeft, Clock, Trash2 } from "lucide-react";
import { authApi, bookingsApi, showtimesApi, type HoldResponse } from "@/api/endpoints";
import { queryKeys } from "@/api/queryKeys";
import { ApiRequestError } from "@/api/http";
import { MAX_SEATS_PER_BOOKING, bulkDiscountPercent, computeQuote } from "@shared/pricing";
import { useAuth } from "@/context/AuthContext";
import { useBookingFlow } from "@/context/BookingFlowContext";
import { useToast } from "@/context/ToastContext";
import { useCountdown } from "@/hooks/useCountdown";
import { useSeatStream } from "@/hooks/useSeatStream";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { formatCountdown, formatShowDateTime, localizeHall } from "@/lib/localize";
import { useAppConfig } from "@/i18n/AppConfigProvider";
import { translateApiError } from "@/lib/errors";
import { cn } from "@/lib/cn";
import { SeatMap } from "@/components/cinema/SeatMap";
import { GuestCheckoutDialog, type GuestCheckoutValues } from "@/components/cinema/GuestCheckoutDialog";
import { track } from "@/lib/analytics";
import { Button } from "@/components/ui/Button";
import { Alert, ErrorState, Skeleton } from "@/components/ui/Feedback";

const SEATS_REFETCH_MS = 15_000;

export default function SeatsPage() {
  const { t } = useTranslation();
  const { locale, money, config } = useAppConfig();
  const { showtimeId = "" } = useParams<{ showtimeId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const { status, startGuestSession } = useAuth();
  const { draft, setSeats, setHold, setBooking, reset } = useBookingFlow();
  const [guestOpen, setGuestOpen] = useState(false);
  const queryClient = useQueryClient();

  const [selectedSeats, setSelectedSeats] = useState<string[]>(
    draft.showtimeId === showtimeId ? draft.seatIds : [],
  );
  const [creatingBooking, setCreatingBooking] = useState(false);
  const expiryNotified = useRef(false);
  /**
   * Seats the server confirmed are held for *us*. Until the seat map is
   * refetched with our hold token it still lists them as "held", and we must
   * not treat our own reservation as somebody else's.
   */
  const heldByUs = useRef<Set<string>>(new Set());

  useDocumentTitle(t("seats.title"));

  // Funnel step before checkout (ТЗ §10).
  useEffect(() => {
    track("view_seat_map", { showtime_id: showtimeId });
  }, [showtimeId]);

  const showtimeQuery = useQuery({
    queryKey: ["showtimes", showtimeId],
    queryFn: () => showtimesApi.get(showtimeId),
    enabled: showtimeId.length > 0,
    staleTime: 5 * 60_000,
  });

  // The buyer is looking at one concrete screening (ТЗ §10: view_screening).
  const showtimeData = showtimeQuery.data?.showtime;
  useEffect(() => {
    if (!showtimeData) return;
    track("view_showtime", {
      showtime_id: showtimeData.id,
      movie_id: showtimeData.movieId,
      theater_id: showtimeData.theaterId,
      starts_at: showtimeData.startsAt,
    });
  }, [showtimeData]);

  const seatsQuery = useQuery({
    queryKey: queryKeys.seats(showtimeId, draft.holdToken),
    queryFn: ({ signal }) => showtimesApi.seats(showtimeId, draft.holdToken, signal),
    enabled: showtimeId.length > 0,
    refetchInterval: SEATS_REFETCH_MS,
    staleTime: 5_000,
  });

  // Live seat updates: the server pushes a `seats` event on every hold or
  // booking change. The 15s polling above stays as a fallback.
  useSeatStream(
    showtimeId,
    () => {
      void seatsQuery.refetch();
    },
    showtimeId.length > 0,
  );

  const seatMap = seatsQuery.data;
  const debouncedSelection = useDebouncedValue(selectedSeats, 400);
  const selectionKey = debouncedSelection.join(",");

  const holdMutation = useMutation<HoldResponse, Error, string[]>({
    mutationFn: (seatIds) => showtimesApi.hold(showtimeId, seatIds, draft.holdToken),
    onSuccess: (result) => {
      heldByUs.current = new Set(result.seats);
      setHold(result.holdToken, result.expiresAt);
      expiryNotified.current = false;
    },
    onError: (error) => {
      toast({
        title:
          error instanceof ApiRequestError && error.code === "seat_unavailable"
            ? t("seats.takenTitle")
            : t("seats.holdFailed"),
        description: translateApiError(error, t),
        variant: "warning",
      });
      void seatsQuery.refetch();
    },
  });

  // Keep the server-side hold in sync with the current selection.
  useEffect(() => {
    if (!showtimeId) return;
    if (selectionKey.length === 0) {
      heldByUs.current.clear();
      if (draft.holdToken) {
        void showtimesApi.release(showtimeId, draft.holdToken).catch(() => undefined);
      }
      return;
    }
    holdMutation.mutate(selectionKey.split(","));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey, showtimeId]);

  // Persist selection for the rest of the flow (and page reloads).
  useEffect(() => {
    setSeats(selectedSeats);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSeats]);

  // Drop seats that somebody else took while this page was open. Seats the
  // server is holding for us are kept, even if the map still lists them as held.
  useEffect(() => {
    if (!seatMap) return;
    const available = new Set(
      seatMap.seats.filter((seat) => seat.status === "available").map((seat) => seat.id),
    );
    setSelectedSeats((current) => {
      const kept = current.filter((id) => available.has(id) || heldByUs.current.has(id));
      return kept.length === current.length ? current : kept;
    });
  }, [seatMap]);

  const remainingMs = useCountdown(draft.holdExpiresAt);
  const expired = Boolean(draft.holdExpiresAt) && remainingMs === 0;

  useEffect(() => {
    if (expired && !expiryNotified.current && selectedSeats.length > 0) {
      expiryNotified.current = true;
      setSelectedSeats([]);
      setSeats([]);
      toast({
        title: t("seats.expiredTitle"),
        description: t("seats.expiredMessage"),
        variant: "warning",
      });
      void seatsQuery.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expired]);

  const toggleSeat = useCallback(
    (seatId: string) => {
      const adding = !selectedSeats.includes(seatId);
      setSelectedSeats((current) => {
        if (current.includes(seatId)) return current.filter((id) => id !== seatId);
        if (current.length >= MAX_SEATS_PER_BOOKING) {
          toast({
            title: t("seats.limitReached"),
            description: t("seats.limitMessage", { max: MAX_SEATS_PER_BOOKING }),
            variant: "warning",
          });
          return current;
        }
        return [...current, seatId];
      });
      if (adding && selectedSeats.length < MAX_SEATS_PER_BOOKING) {
        track("select_seat", { showtime_id: showtimeId, seat_id: seatId });
      }
    },
    [toast, t, selectedSeats, showtimeId],
  );

  const movieDiscount = showtimeQuery.data?.movie?.discountPercent ?? 0;

  const quote = useMemo(() => {
    if (!seatMap) return null;
    const lines = seatMap.seats
      .filter((seat) => selectedSeats.includes(seat.id))
      .map((seat) => ({
        seatId: seat.id,
        label: seat.label,
        seatClass: seat.seatClass,
        priceCents: seat.priceCents,
      }));
    // Mirrors the server: volume discount vs the movie's own promotion —
    // the better offer wins, offers never stack.
    return computeQuote({
      lines,
      discountPercent: Math.max(movieDiscount, bulkDiscountPercent(lines.length)),
      promoCode: null,
    });
  }, [seatMap, selectedSeats, movieDiscount]);

  /** Гостевой checkout (ТЗ §5): аккаунт-«лайт» создаётся на лету. */
  const handleGuestCheckout = async (values: GuestCheckoutValues) => {
    setCreatingBooking(true);
    try {
      const result = await authApi.guestCheckout({
        ...values,
        showtimeId,
        seatIds: selectedSeats,
        holdToken: draft.holdToken ?? undefined,
      });
      startGuestSession(result);
      setBooking(result.booking.id);
      track("guest_checkout", { booking_id: result.booking.id });
      await queryClient.invalidateQueries({ queryKey: ["showtimes", showtimeId, "seats"] });
      setGuestOpen(false);
      navigate(`/checkout/${result.booking.id}`, { replace: true });
    } catch (error) {
      toast({
        title: t("auth.guestFailed"),
        description: translateApiError(error, t),
        variant: "error",
      });
      void seatsQuery.refetch();
    } finally {
      setCreatingBooking(false);
    }
  };

  const handleProceed = async () => {
    if (selectedSeats.length === 0) return;

    // Right after a reload the session is still being restored — offering the
    // guest dialog at that moment would silently sign the buyer out.
    if (status === "loading") return;

    if (status !== "authenticated") {
      // Both paths are offered: sign in (keeps tickets on the account) or
      // continue as a guest without a password.
      setGuestOpen(true);
      return;
    }

    setCreatingBooking(true);
    try {
      const { booking } = await bookingsApi.create({
        showtimeId,
        seatIds: selectedSeats,
        holdToken: draft.holdToken ?? undefined,
      });
      setBooking(booking.id);
      await queryClient.invalidateQueries({ queryKey: ["showtimes", showtimeId, "seats"] });
      navigate(`/checkout/${booking.id}`, { replace: true });
    } catch (error) {
      // A dead session used to be a dead end: the user saw an error toast and
      // stayed on this page. Send them to the login screen instead — with the
      // current URL, so signing in brings them straight back to these seats.
      if (error instanceof ApiRequestError && error.status === 401) {
        navigate("/login", { state: { from: location.pathname + location.search } });
        return;
      }
      toast({
        title: t("checkout.unavailable"),
        description: translateApiError(error, t),
        variant: "error",
      });
      void seatsQuery.refetch();
    } finally {
      setCreatingBooking(false);
    }
  };

  if (showtimeQuery.isPending || seatsQuery.isPending) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-10 sm:px-6">
        <Skeleton className="h-8 w-56" />
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <Skeleton className="h-[520px] rounded-2xl" />
          <Skeleton className="h-72 rounded-2xl" />
        </div>
      </div>
    );
  }

  if (showtimeQuery.isError || seatsQuery.isError || !seatMap) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-16 sm:px-6">
        <ErrorState
          error={showtimeQuery.error ?? seatsQuery.error}
          onRetry={() => {
            void showtimeQuery.refetch();
            void seatsQuery.refetch();
          }}
          title={t("seats.loadError")}
        />
      </div>
    );
  }

  const showtime = showtimeQuery.data.showtime;
  const timeLabel = formatShowDateTime(showtime.startsAt, locale, showtime.timeZone);
  const selectionOrder = seatMap.seats
    .filter((seat) => selectedSeats.includes(seat.id))
    .map((seat) => ({ id: seat.id, label: seat.label }));

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => navigate(-1)}
        leftIcon={<ArrowLeft className="size-4" aria-hidden />}
        className="mb-4"
      >
        {t("common.back")}
      </Button>

      <header className="mb-7">
        <h1 className="text-2xl font-bold text-white sm:text-3xl">{t("seats.title")}</h1>
        <p className="mt-1.5 text-sm text-white/60">
          {showtime.theaterName} · {localizeHall(showtime.hall, t)} · {timeLabel}
          {showtimeQuery.data.capacity
            ? ` · ${t("seats.seatsFree", { left: seatMap.seatsLeft, capacity: seatMap.capacity })}`
            : ""}
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 sm:p-6">
          <SeatMap
            seatMap={seatMap}
            selectedSeatIds={selectedSeats}
            onToggleSeat={toggleSeat}
            disabled={holdMutation.isPending}
          />
        </section>

        <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
              {t("seats.yourSelection")}
            </h2>

            {selectionOrder.length === 0 ? (
              <p className="mt-3 text-sm text-white/50">
                {t("seats.pickSeats", { max: MAX_SEATS_PER_BOOKING })}
              </p>
            ) : (
              <ul className="mt-3 flex flex-wrap gap-2">
                {selectionOrder.map((seat) => (
                  <li key={seat.id}>
                    <span className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500/15 px-2.5 py-1 text-sm font-semibold text-brand-300">
                      {seat.label}
                      <button
                        type="button"
                        onClick={() => toggleSeat(seat.id)}
                        className="rounded text-brand-300/70 transition hover:text-brand-300"
                        aria-label={t("seats.removeSeat", { label: seat.label })}
                      >
                        ×
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {quote && quote.lines.length > 0 ? (
              <dl className="mt-4 space-y-1.5 border-t border-white/10 pt-4 text-sm">
                <div className="flex justify-between text-white/60">
                  <dt>
                    {t("price.subtotal")} · {t("common.seats", { count: quote.lines.length })}
                  </dt>
                  <dd className="tabular-nums">{money(quote.subtotalCents)}</dd>
                </div>
                {quote.discountCents > 0 ? (
                  <div className="flex justify-between text-brand-300">
                    <dt>
                      {t("price.discount")}
                      {quote.discountPercent ? ` −${quote.discountPercent}%` : ""}
                    </dt>
                    <dd className="tabular-nums">−{money(quote.discountCents)}</dd>
                  </div>
                ) : null}
                <div className="flex justify-between text-white/60">
                  <dt>{t("price.serviceFee", { percent: Math.round(config.serviceFeeRate * 100) })}</dt>
                  <dd className="tabular-nums">{money(quote.serviceFeeCents)}</dd>
                </div>
                <div className="flex justify-between pt-1.5 text-base font-semibold text-white">
                  <dt>{t("price.total")}</dt>
                  <dd className="tabular-nums text-brand-400">{money(quote.totalCents)}</dd>
                </div>
              </dl>
            ) : null}

            <Button
              className="mt-5"
              fullWidth
              size="lg"
              disabled={selectionOrder.length === 0}
              loading={creatingBooking || holdMutation.isPending}
              onClick={() => void handleProceed()}
            >
              {t("seats.continue")}
            </Button>

            {selectionOrder.length > 0 ? (
              <button
                type="button"
                onClick={() => {
                  setSelectedSeats([]);
                  setSeats([]);
                  heldByUs.current.clear();
                  if (draft.holdToken) {
                    void showtimesApi.release(showtimeId, draft.holdToken).catch(() => undefined);
                  }
                  reset();
                }}
                className="mt-3 inline-flex w-full items-center justify-center gap-1.5 text-sm text-white/55 transition hover:text-white"
              >
                <Trash2 className="size-3.5" aria-hidden />
                {t("seats.clear")}
              </button>
            ) : null}
          </div>

          {draft.holdExpiresAt && !expired ? (
            <Alert tone="info" className="flex items-center gap-2">
              <Clock className="size-4 shrink-0" aria-hidden />
              <span>
                {t("seats.heldFor")}{" "}
                <strong className={cn("tabular-nums", remainingMs < 60_000 && "text-warning")}>
                  {formatCountdown(remainingMs)}
                </strong>
              </span>
            </Alert>
          ) : null}

          {expired ? (
            <Alert tone="warning" className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>{t("seats.expired")}</span>
            </Alert>
          ) : null}

          <p className="px-1 text-xs text-white/50">{t("seats.releaseNote")}</p>
        </aside>
      </div>
      <GuestCheckoutDialog
        open={guestOpen}
        onClose={() => setGuestOpen(false)}
        loading={creatingBooking}
        onSubmit={handleGuestCheckout}
      />

      {guestOpen ? (
        <div className="mx-auto mt-3 w-full max-w-md text-center text-sm text-white/60">
          <button
            type="button"
            className="text-brand-300 hover:underline"
            onClick={() => {
              setGuestOpen(false);
              navigate("/login", { state: { from: location.pathname + location.search } });
            }}
          >
            {t("seats.signIn")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
