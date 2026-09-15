import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import { maskPhone } from "../smsService.js";
import { fetchWithTimeout } from "./http.js";
import type { SmsProvider, SmsProviderName, SmsSendResult } from "./types.js";

/**
 * Twilio Programmable SMS — POST /Accounts/{SID}/Messages.json with Basic
 * auth, form-encoded `To/From/Body`. Success is 201 + `{ sid: "SM…" }`.
 */
interface TwilioConfig {
  accountSid: string;
  authToken: string;
  from: string;
  apiUrl: string;
  timeoutMs: number;
}

interface TwilioResponse {
  sid?: string;
  status?: string;
  code?: number;
  message?: string;
}

export class TwilioProvider implements SmsProvider {
  readonly name: SmsProviderName = "twilio";

  constructor(
    private readonly config: TwilioConfig = {
      accountSid: env.TWILIO_ACCOUNT_SID ?? "",
      authToken: env.TWILIO_AUTH_TOKEN ?? "",
      from: env.TWILIO_FROM ?? "",
      apiUrl: "https://api.twilio.com",
      timeoutMs: env.SMS_PROVIDER_TIMEOUT_MS,
    },
  ) {
    if (!this.config.accountSid || !this.config.authToken || !this.config.from) {
      throw new Error("Twilio is not configured: set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM");
    }
  }

  async send(to: string, text: string): Promise<SmsSendResult> {
    const url = `${this.config.apiUrl}/2010-04-01/Accounts/${this.config.accountSid}/Messages.json`;
    const auth = Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString("base64");
    try {
      const response = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ To: to, From: this.config.from, Body: text }).toString(),
        },
        this.config.timeoutMs,
      );
      const data = (await response.json().catch(() => ({}))) as TwilioResponse;
      if (!response.ok || !data.sid) {
        logger.error(
          { status: response.status, code: data.code, error: data.message, phone: maskPhone(to) },
          "Twilio refused to send",
        );
        return { delivered: false };
      }
      return { delivered: true, messageId: data.sid };
    } catch (error) {
      logger.error({ err: error, phone: maskPhone(to) }, "Twilio call failed");
      return { delivered: false };
    }
  }
}
