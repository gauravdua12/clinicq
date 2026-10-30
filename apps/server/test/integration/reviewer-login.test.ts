import { afterEach, describe, expect, it } from "vitest";
import { phoneHash } from "@clinicq/db";
import { harness, type H } from "../harness";
import { ensureReviewer } from "../../src/routes/auth";

// Meta App Review login: a made-up staff number with a fixed code (from the server's secrets), never sent on WhatsApp.

let h: H;
const PHONE = "9000000099";
afterEach(async () => {
  delete process.env.REVIEWER_PHONE; delete process.env.REVIEWER_CODE;
  await h?.close();
});

async function withReviewer(code: string): Promise<void> {
  process.env.REVIEWER_PHONE = PHONE;
  process.env.REVIEWER_CODE = code;
  h = await harness({ start: "2026-10-09T12:00:00+05:30" });
  await ensureReviewer(h.ctx);
}

const post = (url: string, payload: unknown, cookie?: string) => h.app.inject({ method: "POST", url, payload: payload as object, headers: cookie ? { cookie } : {} });

describe("App Review login", () => {
  it("logs in with the fixed code, sends nothing on WhatsApp, and is ordinary clinic staff", async () => {
    await withReviewer("482913");
    const sent = h.wa.sent.length;
    expect((await post("/api/auth/otp", { phone: PHONE })).statusCode).toBe(200);
    expect(h.wa.sent.length).toBe(sent); // no message to the made-up number
    const r = await post("/api/auth/verify", { phone: PHONE, code: "482913" });
    expect(r.statusCode).toBe(200);
    const cookie = String(r.headers["set-cookie"]).split(";")[0]!;
    const me = (await h.app.inject({ url: "/api/me", headers: { cookie } })).json();
    expect(me).toMatchObject({ name: "App Reviewer", role: "STAFF", incoloAdmin: false });
    expect((await h.app.inject({ url: "/api/queue/today", headers: { cookie } })).statusCode).toBe(200);
    expect((await h.app.inject({ url: "/api/admin/ai", headers: { cookie } })).statusCode).toBe(403); // no Incolo admin pages
    const staff = await h.db.staffUser.findUniqueOrThrow({ where: { phoneHash: phoneHash(`91${PHONE}`) } });
    expect(staff.onDuty).toBe(false); // never gets staff alerts
  });

  it("a wrong code fails, and five wrong codes lock the attempt", async () => {
    await withReviewer("482913");
    await post("/api/auth/otp", { phone: PHONE });
    for (let i = 0; i < 5; i++) expect((await post("/api/auth/verify", { phone: PHONE, code: "000000" })).statusCode).toBe(401);
    expect((await post("/api/auth/verify", { phone: PHONE, code: "482913" })).statusCode).toBe(401);
  });

  it("switched off (no code): the reviewer account is deactivated and cannot log in", async () => {
    await withReviewer("482913");
    delete process.env.REVIEWER_CODE;
    process.env.REVIEWER_CODE = "";
    await h.close();
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    await h.db.staffUser.create({ data: { clinicId: (await h.db.clinic.findFirstOrThrow()).id, name: "App Reviewer", waPhone: "x", phoneHash: phoneHash(`91${PHONE}`), role: "STAFF" } });
    await ensureReviewer(h.ctx);
    expect((await h.db.staffUser.findUniqueOrThrow({ where: { phoneHash: phoneHash(`91${PHONE}`) } })).active).toBe(false);
    await post("/api/auth/otp", { phone: PHONE });
    expect((await post("/api/auth/verify", { phone: PHONE, code: "482913" })).statusCode).toBe(401);
  });
});

describe("booking from the dashboard reports whether WhatsApp took the confirmation", () => {
  it("whatsappSent is true when sent, false when WhatsApp refuses (the booking is made either way)", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    const login = await h.app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { role: "STAFF" } });
    const sid = login.cookies.find((c) => c.name === "sid")!.value;
    const book = (phone: string, startMin: number) => h.app.inject({ method: "POST", url: "/api/appointments", cookies: { sid }, payload: { name: "Kiran Rao", phone, date: "2026-10-10", startMin, visitType: "NEW" } });
    const ok = await book("9811122334", 600);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ token: "A-1", whatsappSent: true });
    h.wa.failNext = 10; // e.g. not a WhatsApp number, or not a test-number recipient
    const no = await book("9811122335", 620);
    expect(no.statusCode).toBe(200);
    expect(no.json()).toMatchObject({ whatsappSent: false });
    h.wa.failNext = 0;
    expect(await h.db.appointment.count({ where: { status: "BOOKED" } })).toBe(2);
  });
});
