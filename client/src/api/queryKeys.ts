import type { BookingScope } from "./endpoints";

/** Centralised cache keys — one place to invalidate consistently. */
export const queryKeys = {
  config: () => ["config"] as const,
  movies: (locale?: string) => (locale ? (["movies", locale] as const) : (["movies"] as const)),
  movie: (slug: string, locale?: string) =>
    locale ? (["movies", slug, locale] as const) : (["movies", slug] as const),
  promotions: () => ["promotions"] as const,
  /**
   * Includes the hold token: the server marks our own held seats as available,
   * so a different token must never share the cached seat map.
   */
  seats: (showtimeId: string, holdToken?: string | null) =>
    ["showtimes", showtimeId, "seats", holdToken ?? "anonymous"] as const,
  bookings: (scope: BookingScope) => ["bookings", scope] as const,
  booking: (bookingId: string) => ["bookings", bookingId] as const,
  me: () => ["auth", "me"] as const,
  geo: () => ["geo"] as const,
  cities: () => ["cities"] as const,
  theaters: (city: string, locale?: string) => ["theaters", city, locale ?? "any"] as const,
};
