/**
 * Tiny event bus for session loss.
 *
 * The API client clears dead tokens when a refresh fails, but the rest of the
 * app must find out too: otherwise React still believes the user is signed in
 * and every protected page is stuck on a "session expired" error screen.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

export const authEvents = {
  onUnauthorized(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  emitUnauthorized(): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A failing listener must never break the request pipeline.
      }
    }
  },
};
