/**
 * Minimal Circuit Breaker for PSP calls.
 *
 * States: closed (traffic flows) → open (fail fast, no calls) → half-open
 * (a single probe call; success closes the circuit, failure re-opens it).
 * Prevents a dying gateway from piling up timeouts and exhausting the pool.
 */
export type CircuitState = "closed" | "open" | "half-open";

import { circuitBreakerState } from "../../utils/metrics.js";

export interface CircuitBreakerOptions {
  /** Provider name — published as the `payment_provider_circuit_open` gauge. */
  name?: string;
  /** Consecutive failures before the circuit opens. */
  failureThreshold?: number;
  /** How long the circuit stays open before a probe is allowed. */
  resetTimeoutMs?: number;
  /** Successful probes needed to close the circuit from half-open. */
  successThreshold?: number;
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private successes = 0;
  private openedAt = 0;

  constructor(private readonly options: CircuitBreakerOptions = {}) {}

  get currentState(): CircuitState {
    if (this.state === "open" && Date.now() - this.openedAt >= this.resetTimeout) {
      this.transition("half-open");
    }
    return this.state;
  }

  /** Publishes the breaker state so alerts can fire on an open circuit. */
  private transition(next: CircuitState): void {
    this.state = next;
    if (!this.options.name) return;
    try {
      circuitBreakerState.set(next === "open" ? 1 : 0, { provider: this.options.name });
    } catch {
      // Metrics must never break a payment.
    }
  }

  private get failureThreshold(): number {
    return this.options.failureThreshold ?? 5;
  }

  private get resetTimeout(): number {
    return this.options.resetTimeoutMs ?? 30_000;
  }

  private get successThreshold(): number {
    return this.options.successThreshold ?? 1;
  }

  /** Runs `fn` unless the circuit is open (in which case `onOpen` throws). */
  async run<T>(fn: () => Promise<T>, onOpen: () => Error): Promise<T> {
    const state = this.currentState;
    if (state === "open") throw onOpen();
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    if (this.state === "half-open") {
      this.successes += 1;
      if (this.successes >= this.successThreshold) {
        this.failures = 0;
        this.transition("closed");
      }
    } else {
      this.failures = 0;
    }
  }

  private onFailure(): void {
    this.failures += 1;
    if (this.state === "half-open" || this.failures >= this.failureThreshold) {
      this.openedAt = Date.now();
      this.transition("open");
    }
  }
}
