import { useEffect, useRef } from "react";
import { apiStreamUrl } from "@/api/http";

/**
 * Subscribes to the showtime's seat-change stream (SSE). The server emits a
 * `seats` event whenever holds or bookings change; the callback refetches the
 * map. EventSource reconnects on its own; the 15s polling in SeatsPage stays
 * as a fallback for proxies that buffer SSE.
 */
export function useSeatStream(showtimeId: string, onSeatsChanged: () => void, enabled = true): void {
  const callbackRef = useRef(onSeatsChanged);
  callbackRef.current = onSeatsChanged;

  useEffect(() => {
    if (!enabled || showtimeId.length === 0 || typeof EventSource === "undefined") return;
    const source = new EventSource(apiStreamUrl(`/showtimes/${showtimeId}/stream`));
    const handler = () => callbackRef.current();
    source.addEventListener("seats", handler);
    return () => {
      source.removeEventListener("seats", handler);
      source.close();
    };
  }, [showtimeId, enabled]);
}
