import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useCountdown } from "./useCountdown";

interface Props {
  deadline: string | number | null;
}

describe("useCountdown", () => {
  beforeEach(() => {
    // Date must be faked too, otherwise the countdown never moves.
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the full duration as soon as a deadline appears", () => {
    // Regression: a stale 0 on the first render made the seat page believe the
    // hold had already expired, so it released the seats immediately.
    const { result, rerender } = renderHook<number, Props>(({ deadline }: Props) => useCountdown(deadline), {
      initialProps: { deadline: null },
    });

    expect(result.current).toBe(0);

    rerender({ deadline: new Date(Date.now() + 5 * 60_000).toISOString() });
    expect(result.current).toBeGreaterThan(299_000);
  });

  it("counts down and stops at zero", () => {
    // NB: the deadline must be a fixed value — passing `Date.now() + x` inline
    // would create a new target on every render and the clock would never move.
    const deadline = Date.now() + 3_000;
    const { result } = renderHook(() => useCountdown(deadline));

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current).toBeLessThanOrEqual(2_100);
    expect(result.current).toBeGreaterThan(1_900);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(result.current).toBe(0);
  });

  it("drops back to zero when the deadline is cleared", () => {
    const { result, rerender } = renderHook<number, Props>(({ deadline }: Props) => useCountdown(deadline), {
      initialProps: { deadline: new Date(Date.now() + 10_000).toISOString() },
    });

    expect(result.current).toBeGreaterThan(0);
    rerender({ deadline: null });
    expect(result.current).toBe(0);
  });
});
