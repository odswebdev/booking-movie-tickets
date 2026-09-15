import { expect, type Page } from "@playwright/test";

export async function register(page: Page, email: string): Promise<void> {
  await page.goto("/register");
  await page.getByLabel("Full name").fill("E2E Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("Str0ngPassw0rd");
  await page.getByLabel("Confirm password").fill("Str0ngPassw0rd");
  await page.getByRole("button", { name: "Create account" }).click();
  // Routes are locale-prefixed (/en/register) — match the suffix, not the root.
  await page.waitForURL((url) => !url.pathname.endsWith("/register"));
}

/** Picks the first movie, theater, day and time, then opens the Seat Map. */
export async function openFirstShowtimeSeats(page: Page): Promise<void> {
  await page.goto("/");
  // Routes live under a locale prefix (/en, /ru) — match the suffix, not the root.
  await page.locator('a[href*="/movies/"]').first().click();
  await page.waitForURL(/\/movies\//);
  await page.locator('section[aria-labelledby="cinema-heading"] button').first().click();
  await page.locator('section[aria-labelledby="date-heading"] button').first().click();
  await page.locator('section[aria-labelledby="time-heading"] button:not([disabled])').first().click();
  await page.getByRole("button", { name: "Select seats" }).click();
  await page.waitForURL(/\/showtimes\/.+\/seats/);
}

/** Clicks N available seats and continues to checkout (booking is created). */
export async function pickSeats(page: Page, count: number): Promise<void> {
  const free = page.getByRole("button", { name: /available/i });
  for (let i = 0; i < count; i += 1) {
    await free.nth(i).click();
  }
  await page.getByRole("button", { name: "Continue to checkout" }).click();
  await page.waitForURL(/\/checkout\//);
}

export async function applyPromo(page: Page, code: string): Promise<void> {
  await page.getByPlaceholder("e.g. WELCOME10").fill(code);
  await page.getByRole("button", { name: "Apply" }).click();
  // The durable banner (the same text also flashes in a toast — scope it out).
  await expect(page.locator("#main-content").getByText(`Promo code ${code} applied`)).toBeVisible();
}

export async function gotoPayment(page: Page): Promise<void> {
  await page.getByRole("link", { name: /Payment/ }).click();
  await page.waitForURL(/\/payment$/);
}

export async function payByCard(page: Page, phone: string): Promise<void> {
  await page.getByLabel("Card number").fill("4242424242424242");
  await page.getByLabel("Cardholder name").fill("E2E Tester");
  await page.getByLabel("Expiry").fill("12/30");
  await page.getByRole("textbox", { name: "CVC" }).fill("123");
  await page.getByLabel("Phone number").fill(phone);
  await page.getByRole("button", { name: /^Pay · / }).click();
  await expect(page.getByText("Demo mode: your code is")).toBeVisible();
}

export async function readDemoCode(page: Page): Promise<string> {
  const text = await page.getByText("Demo mode: your code is").textContent();
  const code = text?.replace(/\D/g, "") ?? "";
  expect(code).toMatch(/^\d{6}$/);
  return code;
}

export async function fillCode(page: Page, code: string): Promise<void> {
  for (let i = 0; i < code.length; i += 1) {
    await page.getByLabel(`Digit ${i + 1} of 6`).fill(code[i]!);
  }
}

export async function submitCode(page: Page): Promise<void> {
  await page.locator('form button[type="submit"]').click();
}
