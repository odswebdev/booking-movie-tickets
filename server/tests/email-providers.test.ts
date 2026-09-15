import { afterEach, describe, expect, it, vi } from "vitest";
import nodemailer from "nodemailer";
import { emailProvider, emailProviderName, __resetEmailProviders } from "../src/services/email/factory.js";
import { MockEmailProvider, drainEmailOutbox, maskEmail } from "../src/services/email/mock.js";
import { SendgridEmailProvider, parseFrom } from "../src/services/email/sendgrid.js";
import { SmtpEmailProvider } from "../src/services/email/smtp.js";
import type { EmailMessage } from "../src/services/email/types.js";

const MESSAGE: EmailMessage = {
  to: "buyer@example.com",
  subject: "Your tickets",
  html: "<p>hi</p>",
  text: "hi",
};

afterEach(() => {
  vi.unstubAllGlobals();
  __resetEmailProviders();
  drainEmailOutbox();
});

describe("mock email provider", () => {
  it("accepts every message into the outbox", async () => {
    const provider = new MockEmailProvider();
    const result = await provider.send(MESSAGE);
    expect(result.delivered).toBe(true);
    expect(result.messageId).toMatch(/^mock_/);
    expect(drainEmailOutbox()).toEqual([MESSAGE]);
    expect(drainEmailOutbox()).toEqual([]);
  });

  it("masks addresses for logs", () => {
    expect(maskEmail("buyer@example.com")).toBe("b***@example.com");
    expect(maskEmail("not-an-email")).toBe("***");
  });
});

describe("sendgrid provider", () => {
  it("delivers on 202 and reports the message id", async () => {
    let url = "";
    let body = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: { body?: string }) => {
        url = input;
        body = init.body ?? "";
        return new Response(null, { status: 202, headers: { "x-message-id": "sg_1" } });
      }),
    );
    const result = await new SendgridEmailProvider({ apiKey: "SG.test-key" }).send(MESSAGE);
    expect(url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect(JSON.parse(body).personalizations[0].to).toEqual([{ email: "buyer@example.com" }]);
    expect(result).toEqual({ delivered: true, messageId: "sg_1" });
  });

  it("reports failure when the API rejects the message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    );
    const result = await new SendgridEmailProvider({ apiKey: "SG.test-key" }).send(MESSAGE);
    expect(result.delivered).toBe(false);
  });

  it("reports failure on network errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("socket hangup");
      }),
    );
    const result = await new SendgridEmailProvider({ apiKey: "SG.test-key" }).send(MESSAGE);
    expect(result.delivered).toBe(false);
  });

  it("refuses to construct without an API key", () => {
    expect(() => new SendgridEmailProvider()).toThrow("SENDGRID_API_KEY");
  });

  it("parses Name <addr> senders", () => {
    expect(parseFrom("CineTickets <no-reply@cinetickets.example>")).toEqual({
      email: "no-reply@cinetickets.example",
      name: "CineTickets",
    });
    expect(parseFrom("plain@example.com")).toEqual({ email: "plain@example.com" });
  });
});

describe("smtp provider", () => {
  it("sends through the injected transporter (jsonTransport, no network)", async () => {
    const transporter = nodemailer.createTransport({ jsonTransport: true });
    const result = await new SmtpEmailProvider({ transporter }).send(MESSAGE);
    expect(result.delivered).toBe(true);
    expect(typeof result.messageId).toBe("string");
  });

  it("refuses to construct without SMTP_HOST", () => {
    expect(() => new SmtpEmailProvider()).toThrow("SMTP_HOST");
  });
});

describe("email factory", () => {
  it("defaults to mock when nothing is configured", () => {
    expect(emailProviderName()).toBe("mock");
    expect(emailProvider().name).toBe("mock");
  });
});
