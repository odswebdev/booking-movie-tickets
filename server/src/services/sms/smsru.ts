import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import { maskPhone } from "../smsService.js";
import { fetchWithTimeout } from "./http.js";
import type { SmsProvider, SmsProviderName, SmsSendResult } from "./types.js";

/**
 * sms.ru (https://sms.ru/api) — GET /sms/send?api_id=&to=&msg=&json=1.
 * Success: `{ status: "OK", sms: { "<phone>": { sms_id } } }`.
 */
interface SmsRuConfig {
  apiId: string;
  apiUrl: string;
  timeoutMs: number;
}

interface SmsRuResponse {
  status?: string;
  status_code?: number;
  status_text?: string;
  sms?: Record<string, { status?: string; sms_id?: string }>;
}

export class SmsRuProvider implements SmsProvider {
  readonly name: SmsProviderName = "smsru";

  constructor(
    private readonly config: SmsRuConfig = {
      apiId: env.SMSRU_API_ID ?? "",
      apiUrl: "https://sms.ru/sms/send",
      timeoutMs: env.SMS_PROVIDER_TIMEOUT_MS,
    },
  ) {
    if (!this.config.apiId) {
      throw new Error("sms.ru is not configured: set SMSRU_API_ID");
    }
  }

  async send(to: string, text: string): Promise<SmsSendResult> {
    const url = `${this.config.apiUrl}?${new URLSearchParams({ api_id: this.config.apiId, to, msg: text, json: "1" }).toString()}`;
    try {
      const response = await fetchWithTimeout(url, { method: "GET" }, this.config.timeoutMs);
      if (!response.ok) {
        logger.error({ status: response.status, phone: maskPhone(to) }, "sms.ru rejected the message");
        return { delivered: false };
      }
      const data = (await response.json()) as SmsRuResponse;
      if (data.status !== "OK") {
        logger.error(
          { code: data.status_code, text: data.status_text, phone: maskPhone(to) },
          "sms.ru refused to send",
        );
        return { delivered: false };
      }
      const entry = Object.values(data.sms ?? {})[0];
      return { delivered: true, messageId: entry?.sms_id };
    } catch (error) {
      logger.error({ err: error, phone: maskPhone(to) }, "sms.ru call failed");
      return { delivered: false };
    }
  }
}
