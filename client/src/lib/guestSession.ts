/**
 * Гостевая сессия (ТЗ §5): токен, выданный гостю после оформления заказа.
 *
 * The token is a scoped access token for the guest account — sending it as
 * `X-Guest-Token` authenticates the request for exactly that booking, so the
 * checkout wizard, the payment step and the ticket page all work without an
 * account. Claiming the account later keeps the same tickets.
 */
const TOKEN_KEY = "cinetickets:guest-token";
const BOOKING_KEY = "cinetickets:guest-booking";

let memory: { token: string; bookingId: string } | null = null;

export const guestSession = {
  get(): { token: string; bookingId: string } | null {
    if (memory) return memory;
    try {
      const token = localStorage.getItem(TOKEN_KEY);
      const bookingId = localStorage.getItem(BOOKING_KEY);
      if (token && bookingId) memory = { token, bookingId };
    } catch {
      /* storage blocked — the in-memory copy still works for this tab */
    }
    return memory;
  },

  set(token: string, bookingId: string): void {
    memory = { token, bookingId };
    try {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(BOOKING_KEY, bookingId);
    } catch {
      /* ignore */
    }
  },

  clear(): void {
    memory = null;
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(BOOKING_KEY);
    } catch {
      /* ignore */
    }
  },
};

/** Header pair sent with every request made during a guest checkout. */
export function guestHeaders(): Record<string, string> {
  const guest = guestSession.get();
  return guest ? { "X-Guest-Token": guest.token } : {};
}
