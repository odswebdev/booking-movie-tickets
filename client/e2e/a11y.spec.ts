import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openFirstShowtimeSeats, register } from "./helpers";

/**
 * Accessibility audit (ТЗ §9: WCAG 2.2 AA, axe в CI).
 *
 * Runs axe-core over the public funnel with the WCAG 2.0–2.2 A/AA rule tags.
 * A violation fails the build; the assertion message lists rule ids, impacts
 * and the offending selectors so CI logs point straight at the problem.
 */

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function scan(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const summary = results.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact}): ` +
      violation.nodes
        .slice(0, 3)
        .map((node) => `${node.target.join(" ")} — ${node.failureSummary?.split("\n").slice(1).join("; ")}`)
        .join(" | "),
  );
  expect(summary, `a11y violations on ${label}`).toEqual([]);
}

test("public pages meet WCAG 2.2 AA (home, movie, cinemas, auth)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('a[href*="/movies/"]').first()).toBeVisible();
  await scan(page, "home");

  await page.locator('a[href*="/movies/"]').first().click();
  await page.waitForURL(/\/movies\//);
  await expect(page.locator('section[aria-labelledby="cinema-heading"]')).toBeVisible();
  await scan(page, "movie");

  await page.goto("/cinemas");
  await expect(page.locator(".leaflet-container")).toBeVisible();
  // Wait out the fly-in animation: while the map is still zooming, the pins
  // sit on top of each other and would fail the target-size spacing check.
  await page.waitForFunction(
    () => {
      const pins = Array.from(document.querySelectorAll<HTMLElement>(".leaflet-marker-icon"));
      if (pins.length === 0) return false;
      const rects = pins.map((pin) => pin.getBoundingClientRect());
      return rects.every(
        (a, i) =>
          !rects.some(
            (b, j) => i !== j && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom,
          ),
      );
    },
    undefined,
    { timeout: 15_000 },
  );
  await scan(page, "cinemas");

  await page.goto("/login");
  await expect(page.getByLabel("Email")).toBeVisible();
  await scan(page, "login");
});

test("seat map meets WCAG 2.2 AA", async ({ page }) => {
  await register(page, "pw-a11y@example.com");
  await openFirstShowtimeSeats(page);
  await expect(page.getByRole("button", { name: /available/i }).first()).toBeVisible();
  // Deterministic auth state: the header flips to the account menu (with the
  // red Log out button) once the session bootstrap settles — scan after that,
  // not while the header still shows the signed-out controls.
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  await scan(page, "seats");
});
