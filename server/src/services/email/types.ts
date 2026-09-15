export type EmailProviderName = "mock" | "smtp" | "sendgrid";

export interface EmailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  /** Content-Id for inline images (`<img src="cid:...">`). Omit for regular attachments. */
  cid?: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
}

export interface EmailSendResult {
  delivered: boolean;
  messageId?: string;
}

export interface EmailProvider {
  readonly name: EmailProviderName;
  send(message: EmailMessage): Promise<EmailSendResult>;
}
