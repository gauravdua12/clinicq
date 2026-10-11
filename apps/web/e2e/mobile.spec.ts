import { expect, test } from "@playwright/test";
import { loginAs, noHorizontalScroll, setClock } from "./helpers";

// Receptionist on a phone (Pixel 7 viewport).
test.beforeEach(async ({ request }) => { await setClock(request); });

test("every page fits a phone screen and uses the bottom tab bar", async ({ page }) => {
  await loginAs(page);
  await expect(page.locator(".tabbar")).toBeVisible();
  await expect(page.locator(".rail")).toBeHidden();
  for (const path of ["/", "/appointments", "/settings", "/reports", "/demo", "/login"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    expect(await noHorizontalScroll(page), `${path} scrolls sideways`).toBe(true);
  }
});

test("primary action is reachable with a thumb", async ({ page }) => {
  await loginAs(page);
  const btn = page.getByRole("button", { name: /Consultation completed|Send next patient in/ });
  const box = await btn.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(56);
  expect(box!.width).toBeGreaterThan(300);
});
