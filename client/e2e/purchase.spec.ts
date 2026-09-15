import { expect, test } from "@playwright/test";
import {
  applyPromo,
  fillCode,
  gotoPayment,
  openFirstShowtimeSeats,
  payByCard,
  pickSeats,
  readDemoCode,
  register,
  submitCode,
} from "./helpers";

test("full purchase: register → seats → promo → card → SMS → QR ticket", async ({ page }) => {
  await register(page, "pw-purchase@example.com");
  await openFirstShowtimeSeats(page);
  await pickSeats(page, 2);
  await applyPromo(page, "CINEMA20");
  await gotoPayment(page);
  await payByCard(page, "+12025550123");
  await fillCode(page, await readDemoCode(page));
  await submitCode(page);

  await expect(page.getByText("Payment successful")).toBeVisible();
  await page.getByRole("link", { name: "View ticket" }).click();
  await page.waitForURL(/\/tickets\//);
  await expect(page.getByRole("img", { name: /QR code for booking/ })).toBeVisible();
  await expect(page.getByText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/).first()).toBeVisible();
});
