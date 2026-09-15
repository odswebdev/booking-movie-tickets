import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/**
 * Draft of the booking in progress.
 *
 * It lives in sessionStorage so a page reload mid-flow (or a login redirect)
 * does not lose the selected showtime and seats — the original app lost
 * everything, which was one of its most visible bugs.
 */
export interface BookingDraft {
  movieSlug: string | null;
  showtimeId: string | null;
  seatIds: string[];
  holdToken: string | null;
  holdExpiresAt: string | null;
  bookingId: string | null;
  paymentId: string | null;
}

export interface BookingFlowContextValue {
  draft: BookingDraft;
  setSelection: (movieSlug: string, showtimeId: string) => void;
  setSeats: (seatIds: string[]) => void;
  setHold: (holdToken: string, expiresAt: string) => void;
  setBooking: (bookingId: string) => void;
  setPayment: (paymentId: string) => void;
  reset: () => void;
}

const STORAGE_KEY = "cinetickets:booking-draft";

const EMPTY_DRAFT: BookingDraft = {
  movieSlug: null,
  showtimeId: null,
  seatIds: [],
  holdToken: null,
  holdExpiresAt: null,
  bookingId: null,
  paymentId: null,
};

function readDraft(): BookingDraft {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_DRAFT;
    const parsed = JSON.parse(raw) as Partial<BookingDraft>;
    return {
      ...EMPTY_DRAFT,
      ...parsed,
      seatIds: Array.isArray(parsed.seatIds) ? parsed.seatIds.filter((id) => typeof id === "string") : [],
    };
  } catch {
    return EMPTY_DRAFT;
  }
}

const BookingFlowContext = createContext<BookingFlowContextValue | null>(null);

export function BookingFlowProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<BookingDraft>(readDraft);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
    } catch {
      /* storage full or blocked — the flow still works in memory */
    }
  }, [draft]);

  const setSelection = useCallback((movieSlug: string, showtimeId: string) => {
    setDraft((current) => ({
      ...current,
      movieSlug,
      showtimeId,
      // Changing the showtime invalidates seats, holds and the pending order.
      seatIds: [],
      holdToken: null,
      holdExpiresAt: null,
      bookingId: null,
      paymentId: null,
    }));
  }, []);

  const setSeats = useCallback((seatIds: string[]) => {
    setDraft((current) => ({ ...current, seatIds }));
  }, []);

  const setHold = useCallback((holdToken: string, expiresAt: string) => {
    setDraft((current) => ({ ...current, holdToken, holdExpiresAt: expiresAt }));
  }, []);

  const setBooking = useCallback((bookingId: string) => {
    setDraft((current) => ({ ...current, bookingId }));
  }, []);

  const setPayment = useCallback((paymentId: string) => {
    setDraft((current) => ({ ...current, paymentId }));
  }, []);

  const reset = useCallback(() => setDraft(EMPTY_DRAFT), []);

  const value = useMemo<BookingFlowContextValue>(
    () => ({ draft, setSelection, setSeats, setHold, setBooking, setPayment, reset }),
    [draft, setSelection, setSeats, setHold, setBooking, setPayment, reset],
  );

  return <BookingFlowContext.Provider value={value}>{children}</BookingFlowContext.Provider>;
}

export function useBookingFlow(): BookingFlowContextValue {
  const context = useContext(BookingFlowContext);
  if (!context) throw new Error("useBookingFlow must be used inside <BookingFlowProvider>");
  return context;
}
