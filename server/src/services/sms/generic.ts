import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import { maskPhone } from "../smsService.js";
import { fetchWithTimeout } from "./http.js";
import type { SmsProvider, SmsProviderName, SmsSendResult } from "./types.js";

interface GenericSmsConfig {
  url: string;
  token?: string;
  from: string;
  timeoutMs: number;
}

/**
 * Any HTTP gateway: POST `{ to, text, from }` as JSON, `Bearer` auth when a
 * token is set. Used explicitly (`SMS_PROVIDER=generic`) or implicitly when
 * `SMS_PROVIDER_URL` is set without `SMS_PROVIDER`.
 */
export class GenericSmsProvider implements SmsProvider {
  readonly name: SmsProviderName = "generic";

  constructor(
    private readonly config: GenericSmsConfig = {
      url: env.SMS_PROVIDER_URL,
      token: env.SMS_PROVIDER_TOKEN,
      from: env.SMS_FROM || "CineTickets",
      timeoutMs: env.SMS_PROVIDER_TIMEOUT_MS,
    },
  ) {
    if (!this.config.url) {
      throw new Error("Generic SMS gateway is not configured: set SMS_PROVIDER_URL");
    }
  }

  async send(to: string, text: string): Promise<SmsSendResult> {
    try {
      const response = await fetchWithTimeout(
        this.config.url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}),
          },
          body: JSON.stringify({ to, text, from: this.config.from }),
        },
        this.config.timeoutMs,
      );
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        logger.error(
          { status: response.status, body: body.slice(0, 200), phone: maskPhone(to) },
          "SMS gateway rejected the message",
        );
        return { delivered: false };
      }
      return { delivered: true };
    } catch (error) {
      logger.error({ err: error, phone: maskPhone(to) }, "SMS gateway call failed");
      return { delivered: false };
    }
  }
}
