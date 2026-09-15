import { afterEach, describe, expect, it, vi } from "vitest";
import { smsProviderName } from "../src/services/sms/factory.js";
import { GenericSmsProvider } from "../src/services/sms/generic.js";
import { MockSmsProvider } from "../src/services/sms/mock.js";
import { SmsRuProvider } from "../src/services/sms/smsru.js";
import { SmscProvider } from "../src/services/sms/smsc.js";
import { TwilioProvider } from "../src/services/sms/twilio.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(ok: boolean, data: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  });
}

describe("MockSmsProvider", () => {
  it("accepts every message", async () => {
    const result = await new MockSmsProvider().send("+12025550123", "code 123456");
    expect(result.delivered).toBe(true);
    expect(result.messageId).toMatch(/^mock_/);
  });
});

describe("GenericSmsProvider", () => {
  const config = { url: "https://sms.example.com/send", token: "tok", from: "Cine", timeoutMs: 1000 };

  it("POSTs { to, text, from } with Bearer auth", async () => {
    const fetchMock = stubFetch(true, { ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new GenericSmsProvider(config).send("+12025550123", "hello");
    expect(result.delivered).toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("https://sms.example.com/send");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toEqual({ to: "+12025550123", text: "hello", from: "Cine" });
  });

  it("reports gateway rejections as undelivered", async () => {
    vi.stubGlobal("fetch", stubFetch(false, { error: "nope" }, 500));
    const result = await new GenericSmsProvider(config).send("+12025550123", "hello");
    expect(result.delivered).toBe(false);
  });

  it("throws when unconfigured", () => {
    expect(() => new GenericSmsProvider({ ...config, url: "" })).toThrow(/SMS_PROVIDER_URL/);
  });
});

describe("SmsRuProvider", () => {
  const config = { apiId: "key", apiUrl: "https://sms.ru.test/sms/send", timeoutMs: 1000 };

  it("calls the send endpoint and returns the sms id", async () => {
    const fetchMock = stubFetch(true, { status: "OK", sms: { "+12025550123": { sms_id: "1" } } });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new SmsRuProvider(config).send("+12025550123", "code 1");
    expect(result).toEqual({ delivered: true, messageId: "1" });

    const [url] = fetchMock.mock.calls[0] as [string];
    const query = new URL(url).searchParams;
    expect(query.get("api_id")).toBe("key");
    expect(query.get("to")).toBe("+12025550123");
    expect(query.get("msg")).toBe("code 1");
    expect(query.get("json")).toBe("1");
  });

  it("maps an ERROR status to undelivered", async () => {
    vi.stubGlobal("fetch", stubFetch(true, { status: "ERROR", status_code: 200, status_text: "wrong api" }));
    const result = await new SmsRuProvider(config).send("+12025550123", "code 1");
    expect(result.delivered).toBe(false);
  });

  it("throws when unconfigured", () => {
    expect(() => new SmsRuProvider({ ...config, apiId: "" })).toThrow(/SMSRU_API_ID/);
  });
});

describe("SmscProvider", () => {
  const config = {
    login: "user",
    password: "pass",
    apiUrl: "https://smsc.test/sys/send.php",
    timeoutMs: 1000,
  };

  it("sends with fmt=3 and returns the message id", async () => {
    const fetchMock = stubFetch(true, { id: 42, cnt: 1 });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new SmscProvider(config).send("+79161234567", "code 1");
    expect(result).toEqual({ delivered: true, messageId: "42" });

    const [url] = fetchMock.mock.calls[0] as [string];
    const query = new URL(url).searchParams;
    expect(query.get("login")).toBe("user");
    expect(query.get("phones")).toBe("+79161234567");
    expect(query.get("fmt")).toBe("3");
  });

  it("maps error payloads to undelivered", async () => {
    vi.stubGlobal("fetch", stubFetch(true, { error: "wrong login", error_code: 3 }));
    const result = await new SmscProvider(config).send("+79161234567", "code 1");
    expect(result.delivered).toBe(false);
  });

  it("throws when unconfigured", () => {
    expect(() => new SmscProvider({ ...config, password: "" })).toThrow(/SMSC_LOGIN/);
  });
});

describe("TwilioProvider", () => {
  const config = {
    accountSid: "AC123",
    authToken: "tok",
    from: "+15550000000",
    apiUrl: "https://twilio.test",
    timeoutMs: 1000,
  };

  it("POSTs a form-encoded message with Basic auth", async () => {
    const fetchMock = stubFetch(true, { sid: "SM1", status: "queued" }, 201);
    vi.stubGlobal("fetch", fetchMock);

    const result = await new TwilioProvider(config).send("+12025550123", "code 1");
    expect(result).toEqual({ delivered: true, messageId: "SM1" });

    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("https://twilio.test/2010-04-01/Accounts/AC123/Messages.json");
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from("AC123:tok").toString("base64")}`);
    const form = new URLSearchParams(init.body);
    expect(form.get("To")).toBe("+12025550123");
    expect(form.get("From")).toBe("+15550000000");
    expect(form.get("Body")).toBe("code 1");
  });

  it("maps API errors to undelivered", async () => {
    vi.stubGlobal("fetch", stubFetch(false, { code: 20003, message: "auth" }, 401));
    const result = await new TwilioProvider(config).send("+12025550123", "code 1");
    expect(result.delivered).toBe(false);
  });

  it("throws when unconfigured", () => {
    expect(() => new TwilioProvider({ ...config, authToken: "" })).toThrow(/TWILIO/);
  });
});

describe("sms factory", () => {
  it("defaults to the mock provider", () => {
    expect(smsProviderName()).toBe("mock");
  });
});
