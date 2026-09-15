import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import { maskPhone } from "../smsService.js";
import { fetchWithTimeout } from "./http.js";
import type { SmsProvider, SmsProviderName, SmsSendResult } from "./types.js";

/**
 * SMSC.ru (https://smsc.ru/api/http) — GET /sys/send.php with `fmt=3` (JSON).
 * Success: `{ id, cnt }`; error: `{ error, error_code }`. An API key works
 * as the password.
 */
interface SmscConfig {
  login: string;
  password: string;
  apiUrl: string;
  timeoutMs: number;
}

interface SmscResponse {
  id?: number;
  cnt?: number;
  error?: string;
  error_code?: number;
}

export class SmscProvider implements SmsProvider {
  readonly name: SmsProviderName = "smsc";

  constructor(
    private readonly config: SmscConfig = {
      login: env.SMSC_LOGIN ?? "",
      password: env.SMSC_PASSWORD ?? "",
      apiUrl: "https://smsc.ru/sys/send.php",
      timeoutMs: env.SMS_PROVIDER_TIMEOUT_MS,
    },
  ) {
    if (!this.config.login || !this.config.password) {
      throw new Error("SMSC.ru is not configured: set SMSC_LOGIN and SMSC_PASSWORD");
    }
  }

  async send(to: string, text: string): Promise<SmsSendResult> {
    const url = `${this.config.apiUrl}?${new URLSearchParams({ login: this.config.login, psw: this.config.password, phones: to, mes: text, fmt: "3" }).toString()}`;
    try {
      const response = await fetchWithTimeout(url, { method: "GET" }, this.config.timeoutMs);
      if (!response.ok) {
        logger.error({ status: response.status, phone: maskPhone(to) }, "SMSC.ru rejected the message");
        return { delivered: false };
      }
      const data = (await response.json()) as SmscResponse;
      if (typeof data.id !== "number") {
        logger.error(
          { error: data.error, code: data.error_code, phone: maskPhone(to) },
          "SMSC.ru refused to send",
        );
        return { delivered: false };
      }
      return { delivered: true, messageId: String(data.id) };
    } catch (error) {
      // Never log the URL — it carries the credentials.
      logger.error({ err: error, phone: maskPhone(to) }, "SMSC.ru call failed");
      return { delivered: false };
    }
  }
}
