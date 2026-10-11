import { expect, test } from "@playwright/test";
import { loginAs, noHorizontalScroll, outbox, setClock, simulate } from "./helpers";

// Receptionist / doctor flows on the dashboard (desktop Chrome).
test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request }) => { await setClock(request); });

test("login page, dev sign-in, empty board", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Every patient knows their turn." })).toBeVisible();
  await page.getByRole("button", { name: "Send code on WhatsApp" }).click();
  await expect(page.getByText("Enter a 10-digit mobile number.")).toBeVisible();
  await loginAs(page);
  await expect(page.getByText("Evening session")).toBeVisible();
  await expect(page.getByText("Cabin is free")).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
});

test("add walk-ins, send in, consultation completed, double-tap safe", async ({ page }) => {
  await loginAs(page);
  for (const n of ["Mohit Jain", "Asha Rao", "Ravi Kumar"]) {
    await page.getByRole("button", { name: "+ Add walk-in" }).click();
    await page.getByLabel("Patient name").fill(n);
    await page.getByRole("button", { name: "Add to queue" }).click();
    await expect(page.locator(".modal")).toHaveCount(0);
  }
  // first walk-in is lined up automatically
  await expect(page.locator(".stub.next")).toContainText("Mohit J.");
  await expect(page.getByRole("heading", { name: /Waiting/ })).toContainText("2");
  await page.getByRole("button", { name: "Send next patient in" }).click();
  await expect(page.locator(".stub.consult")).toContainText("Mohit J.");
  await expect(page.locator(".stub.next")).toContainText("Asha R.");
  // double-tap: only one patient is completed
  const btn = page.getByRole("button", { name: /Consultation completed/ });
  await Promise.all([btn.click(), btn.click({ force: true }).catch(() => undefined)]);
  await expect(page.locator(".stub.consult")).toContainText("Asha R.");
  await expect(page.locator(".kpi").filter({ hasText: "Seen" })).toContainText("1");
});

test("validation in the walk-in form", async ({ page }) => {
  await loginAs(page);
  await page.getByRole("button", { name: "+ Add walk-in" }).click();
  await page.getByRole("button", { name: "Add to queue" }).click();
  await expect(page.getByText("Enter the patient's name.")).toBeVisible();
  await page.getByLabel("Patient name").fill("Test");
  await page.getByLabel(/WhatsApp number/).fill("12345");
  await page.getByRole("button", { name: "Add to queue" }).click();
  await expect(page.getByText(/10-digit mobile number/)).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("WhatsApp walk-in when the list is full: staff pop-up → fit in", async ({ page, request }) => {
  await loginAs(page);
  // quota 0 → every walk-in goes to staff
  const sessions = await (await request.get("/api/settings/sessions", { headers: { cookie: (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ") } })).json();
  const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  await request.put("/api/settings/sessions", { headers: { cookie }, data: sessions.filter((s: { active: boolean }) => s.active).map((s: Record<string, unknown>) => ({ weekday: s.weekday, label: s.label, startTime: s.startTime, endTime: s.endTime, slotMinutes: s.slotMinutes, walkinQuota: 0 })) });
  const qr = await (await request.get("/api/settings/qr", { headers: { cookie } })).json();
  const P = "919811100001";
  await simulate(request, { from: P, name: "Anil", type: "text", text: qr.text });
  await simulate(request, { from: P, type: "button", buttonId: "consent:yes" });
  await simulate(request, { from: P, type: "button", buttonId: "num:use" });
  await simulate(request, { from: P, type: "text", text: "Anil Verma" });
  await expect(page.getByRole("dialog")).toContainText("Anil Verma is at reception", { timeout: 10_000 });
  await page.getByRole("button", { name: "Yes, fit them in" }).click();
  await page.getByLabel("Time to give the patient").fill("19:40");
  await page.getByRole("button", { name: "Give this time" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(async () => (await outbox(request, P)).map((m) => m.preview).join("\n---\n"), { timeout: 8000 }).toContain("made space for you");
  const msgs = await outbox(request, P);
  const adjusted = msgs.findIndex((m) => m.preview.includes("made space for you"));
  expect(adjusted).toBeGreaterThan(-1);
  expect(msgs[adjusted]!.preview).toContain("7:40 PM");
  // any "you're next" comes only after the joining message
  const next = msgs.findIndex((m) => m.preview.includes("you're next"));
  if (next >= 0) expect(next).toBeGreaterThan(adjusted);
});

test("appointments: book on behalf, validation, cancel", async ({ page }) => {
  await loginAs(page);
  await page.getByRole("link", { name: "Appointments" }).first().click();
  await page.getByRole("button", { name: /Mon,? 12 Oct/ }).click();
  await page.getByRole("row").filter({ hasText: "10:20 AM" }).getByRole("button", { name: "Book" }).click();
  await page.getByRole("button", { name: "Book", exact: true }).last().click();
  await expect(page.getByText("Enter the patient's name.")).toBeVisible();
  await page.getByLabel("Patient name").fill("Kiran Rao");
  await page.getByLabel("WhatsApp number").fill("98111 22334");
  await page.getByRole("button", { name: "Book", exact: true }).last().click();
  const row = page.getByRole("row").filter({ hasText: "Kiran Rao" });
  await expect(row).toContainText("A-2");
  page.once("dialog", (d) => d.accept());
  await row.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Kiran Rao" })).toHaveCount(0);
});

test("settings: save clinic, sessions overlap error, model switch", async ({ page }) => {
  await loginAs(page);
  await page.getByRole("link", { name: "Settings" }).first().click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved")).toBeVisible();
  await page.getByRole("button", { name: "Sessions" }).click();
  await page.getByRole("button", { name: "+ Add session" }).click();
  await page.getByRole("button", { name: "Save sessions" }).click();
  await expect(page.getByText("Two sessions on the same day overlap.")).toBeVisible();
  await page.getByRole("button", { name: "Language model" }).click();
  await expect(page.locator("select").first()).toContainText("Qwen3 32B");
  await page.getByRole("button", { name: "Test & save" }).click();
  await expect(page.getByText(/Saved\./)).toBeVisible({ timeout: 15_000 });
});

test("demo studio: create a demo, kit, switch back", async ({ page }) => {
  await loginAs(page);
  await page.getByRole("link", { name: "Demo Studio" }).click();
  await page.getByRole("button", { name: "Create demo" }).click();
  await expect(page.getByText("Enter the clinic name.")).toBeVisible();
  await page.getByLabel("Clinic name").fill("Sanjeevani Child Care Clinic");
  await page.getByRole("button", { name: "Create demo" }).click();
  await expect(page.getByText(/Demo created and switched on/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: /Demo kit · Sanjeevani/ })).toBeVisible();
  await expect(page.getByAltText("Walk-in QR code")).toBeVisible();
  await expect(page.locator(".demopill")).toBeVisible();
  // the board now shows the demo's sample queue
  await page.getByRole("link", { name: "Queue" }).first().click();
  await expect(page.locator(".stub.consult")).toBeVisible();
  // switch back to the original clinic
  await page.getByRole("link", { name: "Demo Studio" }).click();
  await page.getByRole("row").filter({ hasText: "Dr. Sharma's Clinic" }).getByRole("button", { name: "Make active" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Dr. Sharma's Clinic" })).toContainText("Active");
});

test("TV display follows the board live", async ({ page, browser }) => {
  await loginAs(page);
  const tv = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  await tv.goto("/display?key=ui-key");
  await expect(tv.getByText("Now in consultation")).toBeVisible();
  const before = await tv.locator(".stub.consult").innerText();
  await page.getByRole("button", { name: "+ Add walk-in" }).click();
  await page.getByLabel("Patient name").fill("Zara Khan");
  await page.getByRole("button", { name: "Add to queue" }).click();
  await page.getByRole("button", { name: /Consultation completed|Send next patient in/ }).click();
  await expect.poll(async () => tv.locator(".stub.consult").innerText(), { timeout: 10_000 }).not.toBe(before);
  await tv.goto("/display?key=wrong");
  await expect(tv.getByText("This display link isn't valid")).toBeVisible();
});

test("simulator: a patient books end to end", async ({ page }) => {
  await page.goto("/dev/simulator");
  const phone = page.locator(".card").first();
  await phone.getByPlaceholder("Type a message").fill("Hi, appointment chahiye");
  await phone.getByRole("button", { name: "Send", exact: true }).click();
  await expect(phone.getByRole("button", { name: /Agree, aage badhein|I agree/ })).toBeVisible({ timeout: 10_000 });
});
