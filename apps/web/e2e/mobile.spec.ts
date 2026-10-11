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

test("patient books on the booking page from WhatsApp: swipe dates and slots, confirm, booked", async ({ page, request }) => {
  await setClock(request, "2026-10-09T12:00:00+05:30");
  const from = "919811100555";
  for (const step of [{ type: "text", text: "Hi", name: "Jatin" }, { type: "button", buttonId: "consent:yes" }, { type: "button", buttonId: "num:use" }, { type: "text", text: "book appointment" }, { type: "button", buttonId: "who:me" }]) {
    await request.post("/dev/simulate", { data: { from, ...step } });
  }
  const msgs = await (await request.get(`/dev/outbox?to=${from}`)).json() as { msg: { kind: string; url?: string } }[];
  const link = msgs.map((m) => m.msg).reverse().find((m) => m.kind === "cta_url");
  expect(link?.url).toMatch(/\/book\?t=/);
  await page.goto(new URL(link!.url!).pathname + new URL(link!.url!).search);
  await expect(page.getByRole("heading", { name: "Book an appointment" })).toBeVisible();
  await expect(page.getByRole("option", { name: /Sun 11 Oct, Closed/ })).toBeDisabled();
  await page.getByRole("option", { name: "Mon 12 Oct" }).click();
  await expect(page.getByRole("listbox", { name: "Morning" })).toBeVisible();
  await expect(page.getByRole("listbox", { name: "Evening" })).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true); // only the strips scroll sideways
  const slot = page.getByRole("option", { name: "6:10 PM" });
  await slot.scrollIntoViewIfNeeded();
  await slot.click();
  await page.getByRole("button", { name: "Follow-up" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  const sheet = page.getByRole("dialog", { name: "Confirm booking" });
  await expect(sheet).toContainText("Mon, 12 Oct");
  await expect(sheet).toContainText("6:10 PM");
  await expect(sheet).toContainText("Follow-up");
  await sheet.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByRole("heading", { name: "Booked" })).toBeVisible();
  const after = await (await request.get(`/dev/outbox?to=${from}`)).json() as { preview: string }[];
  expect(after.at(-1)!.preview).toMatch(/Mon 12 Oct, 6:10 PM · Follow-up/);
});
