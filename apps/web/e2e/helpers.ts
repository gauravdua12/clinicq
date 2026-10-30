import type { APIRequestContext, Page } from "@playwright/test";

/** Fri 9 Oct 2026, 18:00 IST — evening session running (server dev clock). */
export async function setClock(request: APIRequestContext, iso = "2026-10-09T18:00:00+05:30") {
  await request.post("/dev/clock", { data: { now: iso } });
}
/** Dev sign-in. A clinic's logins land on their clinic's queue; an Incolo admin lands in the admin portal. */
export async function loginAs(page: Page, role: "Doctor" | "Clinic admin" | "Staff" | "Incolo admin" = "Doctor") {
  await page.goto("/login");
  await page.waitForLoadState("networkidle"); // wait for hydration before clicking
  await page.getByRole("button", { name: role, exact: true }).click();
  await page.waitForURL((u) => u.pathname === (role === "Incolo admin" ? "/admin" : "/"));
}
export async function simulate(request: APIRequestContext, body: Record<string, unknown>) {
  const r = await request.post("/dev/simulate", { data: body });
  if (!r.ok()) throw new Error(`simulate ${r.status()}`);
}
export async function outbox(request: APIRequestContext, to: string): Promise<{ preview: string; msg: { kind: string; buttons?: { id: string; title: string }[] } }[]> {
  return (await request.get(`/dev/outbox?to=${to}`)).json();
}
export async function noHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}
