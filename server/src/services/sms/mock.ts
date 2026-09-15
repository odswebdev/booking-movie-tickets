/* eslint-disable @typescript-eslint/require-await -- async shape is dictated by the SmsProvider interface */
import { newId } from "../../utils/ids.js";
import { logger } from "../../utils/logger.js";
import { maskPhone } from "../smsService.js";
import type { SmsProvider, SmsProviderName, SmsSendResult } from "./types.js";

/**
 * Demo gateway: every message is "delivered" (logged, never sent).
 * The code itself is echoed back as `devCode` by the payment service.
 * Refused in production — see `sendSmsCode`.
 */
export class MockSmsProvider implements SmsProvider {
  readonly name: SmsProviderName = "mock";

  async send(to: string, text: string): Promise<SmsSendResult> {
    logger.info(
      { phone: maskPhone(to), length: text.length },
      "[sms:mock] message accepted (logged, not sent)",
    );
    return { delivered: true, messageId: `mock_${newId("sms").slice(4)}` };
  }
}
