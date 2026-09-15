import { expect, test } from "@playwright/test";
import {
  fillCode,
  gotoPayment,
  openFirstShowtimeSeats,
  payByCard,
  pickSeats,
  readDemoCode,
  register,
  submitCode,
} from "./helpers";

test("wrong code shows an error, resend delivers a working code", async ({ page }) => {
  await register(page, "pw-sms@example.com");
  await openFirstShowtimeSeats(page);
  await pickSeats(page, 1);
  await gotoPayment(page);
  await payByCard(page, "+12025550444");

  await fillCode(page, "000000");
  await submitCode(page);
  // Server rejected the code: the durable attempts counter drops 3 → 2.
  await expect(page.getByText("2 attempts remaining")).toBeVisible();

  const staleCode = await readDemoCode(page);
  // 30s client cooldown, then the resend button enables itself.
  const resend = page.getByRole("button", { name: "Resend code" });
  await expect(resend).toBeEnabled({ timeout: 45_000 });
  await resend.click();
  // The banner already shows the old code — wait until it rotates to the new one.
  await expect(page.getByText("Demo mode: your code is")).not.toContainText(staleCode, {
    timeout: 15_000,
  });

  await fillCode(page, await readDemoCode(page));
  await submitCode(page);
  await expect(page.getByText("Payment successful")).toBeVisible();
});
