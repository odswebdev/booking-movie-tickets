import { useEffect, useState } from "react";

function remainingFor(target: number | null): number {
  return target === null ? 0 : Math.max(0, target - Date.now());
}

/**
 * Milliseconds remaining until `deadline` (an ISO string or epoch ms).
 *
 * The deadline is part of the hook state so that changing it never exposes a
 * stale value to the caller — a stale `0` used to look like "already expired"
 * for one render right after a timer was (re)started.
 */
export function useCountdown(deadline: string | number | null, intervalMs = 1000): number {
  const target =
    deadline === null ? null : typeof deadline === "number" ? deadline : new Date(deadline).getTime();
  const [state, setState] = useState(() => ({ target, remaining: remainingFor(target) }));

  if (state.target !== target) {
    // Render-phase state adjustment (the React-recommended way to derive state).
    setState({ target, remaining: remainingFor(target) });
  }

  useEffect(() => {
    if (target === null) return;
    setState({ target, remaining: remainingFor(target) });

    const id = window.setInterval(() => {
      const remaining = remainingFor(target);
      setState({ target, remaining });
      if (remaining === 0) window.clearInterval(id);
    }, intervalMs);

    return () => window.clearInterval(id);
  }, [target, intervalMs]);

  return state.target === target ? state.remaining : remainingFor(target);
}
