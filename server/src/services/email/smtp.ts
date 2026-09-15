import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import { maskEmail } from "./mock.js";
import type { EmailMessage, EmailProvider, EmailProviderName, EmailSendResult } from "./types.js";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  timeoutMs: number;
  from: string;
  /** Test seam: skips relay creation entirely (e.g. `jsonTransport`, no network). */
  transporter?: Transporter;
}

/** SMTP relay via nodemailer (config mirrors the SMS providers: env-backed, overridable). */
export class SmtpEmailProvider implements EmailProvider {
  readonly name: EmailProviderName = "smtp";
  private readonly config: SmtpConfig;
  private transporter: Transporter | null = null;

  constructor(config: Partial<SmtpConfig> = {}) {
    const host = config.host ?? env.SMTP_HOST;
    if (!config.transporter && !host) {
      throw new Error("SMTP_HOST must be set for the smtp email provider");
    }
    this.config = {
      host,
      port: config.port ?? env.SMTP_PORT,
      secure: config.secure ?? env.SMTP_SECURE,
      user: config.user ?? env.SMTP_USER,
      pass: config.pass ?? env.SMTP_PASS,
      timeoutMs: config.timeoutMs ?? env.SMTP_TIMEOUT_MS,
      from: config.from ?? env.EMAIL_FROM,
      transporter: config.transporter,
    };
  }

  private transport(): Transporter {
    if (!this.transporter) {
      this.transporter =
        this.config.transporter ??
        nodemailer.createTransport({
          host: this.config.host,
          port: this.config.port,
          secure: this.config.secure,
          auth: this.config.user ? { user: this.config.user, pass: this.config.pass } : undefined,
          connectionTimeout: this.config.timeoutMs,
          socketTimeout: this.config.timeoutMs,
        });
    }
    return this.transporter;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const info = await this.transport().sendMail({
      from: this.config.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      attachments: message.attachments?.map((attachment) => ({
        filename: attachment.filename,
        content: attachment.content,
        contentType: attachment.contentType,
        cid: attachment.cid,
      })),
    });
    logger.info({ to: maskEmail(message.to), provider: this.name, messageId: info.messageId }, "email sent");
    return { delivered: true, messageId: info.messageId };
  }
}
