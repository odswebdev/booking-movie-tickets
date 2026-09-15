/**
 * SMS providers (Strategy pattern, mirrors the payment providers).
 *
 * The OTP flow stays the same for every gateway: the service generates the
 * code, the provider delivers it, and only delivery success/failure flows
 * back. Providers return `{ delivered: false }` on gateway/transport
 * failures (logged, mapped to 402 upstream) and throw only when they are
 * misconfigured (missing credentials) — fail fast at startup, not mid-flow.
 */
export type SmsProviderName = "mock" | "generic" | "smsru" | "smsc" | "twilio";

export interface SmsSendResult {
  delivered: boolean;
  /** Gateway-side message id, for delivery tracking. */
  messageId?: string;
}

export interface SmsProvider {
  readonly name: SmsProviderName;
  send(to: string, text: string): Promise<SmsSendResult>;
}
