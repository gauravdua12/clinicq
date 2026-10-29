import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { phoneHash } from "@clinicq/db";
import type { OutMsg } from "@clinicq/wa";
import { harness, onboard, type H } from "../harness";

// Follow-up reminders (FU-01, FU-02) and payment reminders (PR-01…PR-04): utility messages about the patient's own visit.

let h: H;
let n = 0;
const nextPhone = () => `9198${String(++n).padStart(8, "0")}`;
beforeEach(async () => { h = await harness({ start: "2026-10-09T12:00:00+05:30" }); });
afterEach(async () => h?.close());

async function login(role: "STAFF" | "DOCTOR" = "STAFF"): Promise<string> {
  const r = await h.app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { role } });
  return r.cookies.find((c) => c.name === "sid")!.value;
}
// Logs in for every call: the test clock jumps days ahead, past the 12-hour staff session.
const call = async (role: "STAFF" | "DOCTOR", method: "GET" | "POST" | "DELETE" | "PUT", url: string, payload?: object) =>
  h.app.inject({ method, url, cookies: { sid: await login(role) }, ...(payload ? { payload } : {}) });
/** Message kinds (copy ids / template names) sent to this patient after the first `from`. */
const kindsSince = async (P: string, from: number) => (await h.kinds(P)).slice(from);
const REMINDER_KINDS = /FOLLOWUP_DUE|followup_due|PAYMENT_DUE|payment_due/;

/** A patient who booked Monday morning (12 Oct) on WhatsApp; returns the appointment id. */
async function bookedPatient(P: string): Promise<string> {
  await onboard(h, P);
  await h.say(P, "book Monday morning for me");
  await h.tap(P, "who:me"); await h.tap(P, h.buttons(P)[0]!.id); await h.tap(P, "vt:NEW"); await h.tap(P, "bk:yes");
  return (await h.db.appointment.findFirstOrThrow({ where: { status: "BOOKED", profile: { account: { phoneHash: phoneHash(P) } } } })).id;
}
const lastOf = (P: string, kind: OutMsg["kind"]) => h.wa.to(P).filter((m) => m.kind === kind).at(-1);
async function setUpi(upiId: string): Promise<void> {
  const doc = "DOCTOR" as const;
  const cur = (await call(doc, "GET", "/api/settings/clinic")).json() as { settings: { paymentReminders: Record<string, unknown> } };
  expect((await call(doc, "PUT", "/api/settings/clinic", { settings: { paymentReminders: { ...cur.settings.paymentReminders, upiId, payeeName: "Dr Sharma Clinic" } } })).statusCode).toBe(200);
}

describe("follow-up reminders", () => {
  it("reminds 2 days before the due date; 'Book' offers times on that date and books a follow-up visit", async () => {
    const P = nextPhone();
    const apptId = await bookedPatient(P);
    const sid = "STAFF" as const;
    const r = await call(sid, "POST", "/api/followups", { appointmentId: apptId, dueDate: "2026-10-19" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ dueDate: "2026-10-19", remindOn: "2026-10-17" });
    expect((await call(sid, "GET", "/api/followups")).json()).toMatchObject([{ dueDate: "2026-10-19", status: "scheduled" }]);

    const before = (await h.kinds(P)).length;
    await h.at("2026-10-17T09:59:00+05:30");
    expect((await kindsSince(P, before)).filter((k) => REMINDER_KINDS.test(k))).toEqual([]); // not yet
    await h.at("2026-10-17T10:00:30+05:30");
    // outside the 24-hour window: the approved template, its button carrying this follow-up
    const tpl = lastOf(P, "template");
    expect(tpl).toMatchObject({ name: "followup_due", bodyParams: ["Ramesh", "Dr. Sharma", expect.stringContaining("19")] });
    const payload = (tpl as { quickReplyPayloads: string[] }).quickReplyPayloads[0]!;
    expect(payload).toMatch(/^fu:/);

    await h.tap(P, payload, "Book now");
    const k = await h.kinds(P);
    expect(["OFFER_NEAR_SLOTS", "LIST_PICKER", "BOOK_LINK"], k.join("+")).toContain(k.at(-1));
    if (k.at(-1) === "OFFER_NEAR_SLOTS") expect(h.buttons(P)[0]!.id).toContain("2026-10-19");
    await h.tap(P, h.buttons(P)[0]!.id);
    expect((await h.kinds(P)).at(-1)).toBe("CONFIRM_BOOKING_ASK"); // visit type is already "follow-up"
    await h.tap(P, "bk:yes");
    const fu = await h.db.followUp.findFirstOrThrow();
    const appt = await h.db.appointment.findUniqueOrThrow({ where: { id: fu.bookedAppointmentId! } });
    expect(appt.visitType).toBe("FOLLOW_UP");
    expect((await call(sid, "GET", "/api/followups")).json()).toMatchObject([{ status: "booked" }]);
  });

  it("no reminder when the patient already booked; a cancelled follow-up sends nothing", async () => {
    const P = nextPhone(); const apptId = await bookedPatient(P);
    const sid = "STAFF" as const;
    await call(sid, "POST", "/api/followups", { appointmentId: apptId, dueDate: "2026-10-13" }); // reminder due now-ish
    // the patient books a visit for the 13th themselves first
    await h.say(P, "book Tuesday evening for me"); await h.tap(P, "who:me"); await h.tap(P, h.buttons(P)[0]!.id); await h.tap(P, "vt:FOLLOW_UP"); await h.tap(P, "bk:yes");
    const sent = (await h.kinds(P)).length;
    await h.at("2026-10-11T10:00:30+05:30");
    expect((await kindsSince(P, sent)).filter((k) => REMINDER_KINDS.test(k))).toEqual([]);
    expect((await h.db.followUp.findFirstOrThrow()).bookedAppointmentId).not.toBeNull();

    const Q = nextPhone(); const a2 = await bookedPatient(Q);
    const f = (await call(sid, "POST", "/api/followups", { appointmentId: a2, dueDate: "2026-10-25" })).json() as { id: string };
    expect((await call(sid, "DELETE", `/api/followups/${f.id}`)).statusCode).toBe(200);
    const sentQ = (await h.kinds(Q)).length;
    await h.at("2026-10-23T10:00:30+05:30");
    expect((await kindsSince(Q, sentQ)).filter((k) => REMINDER_KINDS.test(k))).toEqual([]);
  });

  it("rejects a past date, and a walk-in without WhatsApp", async () => {
    const P = nextPhone(); const apptId = await bookedPatient(P);
    const sid = "STAFF" as const;
    expect((await call(sid, "POST", "/api/followups", { appointmentId: apptId, dueDate: "2026-10-08" })).json()).toMatchObject({ error: { code: "bad_date" } });
    await h.at("2026-10-12T10:05:00+05:30");
    const w = await call(sid, "POST", "/api/queue/walkin", { name: "Anil Verma" });
    expect(w.statusCode).toBe(200);
    const entry = await h.db.queueEntry.findFirstOrThrow({ where: { source: "W" } });
    expect((await call(sid, "POST", "/api/followups", { queueEntryId: entry.id, dueDate: "2026-10-20" })).json()).toMatchObject({ error: { code: "no_whatsapp" } });
  });
});

describe("payment reminders", () => {
  it("needs the clinic's UPI ID first", async () => {
    const P = nextPhone(); const apptId = await bookedPatient(P);
    const sid = "STAFF" as const;
    expect((await call(sid, "POST", "/api/payments", { appointmentId: apptId, amount: 500 })).json()).toMatchObject({ error: { code: "no_upi" } });
  });

  it("sends the amount with a Pay now link; reminds again every 3 days (twice); stops when marked paid; sends a receipt", async () => {
    await setUpi("drsharma@okicici");
    const P = nextPhone(); const apptId = await bookedPatient(P);
    const sid = "STAFF" as const;
    const r = await call(sid, "POST", "/api/payments", { appointmentId: apptId, amount: 500 });
    expect(r.json()).toMatchObject({ whatsappSent: true });
    const msg = h.wa.last(P) as Extract<OutMsg, { kind: "cta_url" }>;
    expect(msg.kind).toBe("cta_url");
    expect(msg.body).toContain("₹500");
    expect(msg.displayText).toBe("Pay now");
    const token = new URL(msg.url).searchParams.get("t")!;

    // the pay page: amount and UPI, never the patient's name
    const page = (await h.app.inject({ url: `/api/pay/${token}` })).json() as Record<string, string>;
    expect(page).toMatchObject({ amount: "500", status: "PENDING", upiId: "drsharma@okicici" });
    expect(page.upiLink).toMatch(/^upi:\/\/pay\?pa=drsharma%40okicici&pn=Dr\+Sharma\+Clinic&am=500\.00&cu=INR/);
    expect(page.qr).toMatch(/^data:image\/png;base64,/);
    expect(JSON.stringify(page)).not.toContain("Ramesh");
    expect((await h.app.inject({ url: "/api/pay/nonexistent-token" })).statusCode).toBe(404);

    // 3 days later at 11:00 (outside the 24-hour window): the approved template with the pay-page button
    await h.at("2026-10-12T11:00:30+05:30");
    const t1 = lastOf(P, "template") as Extract<OutMsg, { kind: "template" }>;
    expect(t1).toMatchObject({ name: "payment_due", bodyParams: ["Ramesh", "500", "Dr. Sharma's Clinic", expect.any(String)], urlButtonParam: token });
    await h.at("2026-10-15T11:00:30+05:30");
    await h.at("2026-10-18T11:00:30+05:30");
    const rows = ((await call(sid, "GET", "/api/payments")).json() as { rows: { remindersSent: number }[] }).rows;
    expect(rows[0]!.remindersSent).toBe(3); // the first message + 2 reminders, then no more
    const sent = (await h.kinds(P)).length;
    await h.at("2026-10-25T11:00:30+05:30");
    expect((await kindsSince(P, sent)).filter((k) => REMINDER_KINDS.test(k))).toEqual([]);

    const id = (await h.db.paymentDue.findFirstOrThrow()).id;
    expect((await call(sid, "POST", `/api/payments/${id}/paid`)).statusCode).toBe(200);
    expect(lastOf(P, "template")).toMatchObject({ name: "payment_received", bodyParams: ["Ramesh", "500", expect.any(String)] });
    expect(((await h.app.inject({ url: `/api/pay/${token}` })).json() as { status: string }).status).toBe("PAID");
    expect((await call(sid, "POST", `/api/payments/${id}/paid`)).json()).toMatchObject({ error: { code: "not_pending" } });
  });

  it("the patient replies 'paid': the clinic is told, reminders stop; 'remind now' can't be spammed", async () => {
    await setUpi("drsharma@okicici");
    const P = nextPhone(); const apptId = await bookedPatient(P);
    const sid = "STAFF" as const;
    await call(sid, "POST", "/api/payments", { appointmentId: apptId, amount: 750 });
    const id = (await h.db.paymentDue.findFirstOrThrow()).id;
    expect((await call(sid, "POST", `/api/payments/${id}/remind`)).json()).toMatchObject({ error: { code: "too_soon" } });

    const events: string[] = [];
    h.ctx.bus.subscribe((e) => events.push(e.type));
    await h.say(P, "I have paid");
    expect((await h.kinds(P)).at(-1)).toBe("PAYMENT_CLAIMED");
    expect(h.lastText(P)).toContain("₹750");
    expect(events).toContain("payment.claimed");
    expect(((await call(sid, "GET", "/api/payments")).json() as { rows: { claimedPaid: boolean }[] }).rows[0]!.claimedPaid).toBe(true);
    const sent = (await h.kinds(P)).length;
    await h.at("2026-10-12T11:00:30+05:30");
    expect((await kindsSince(P, sent)).filter((k) => REMINDER_KINDS.test(k))).toEqual([]); // no reminder after "paid"

    // Hindi and Hinglish too; with nothing pending, "paid" is just an ordinary message
    const Q = nextPhone(); const a2 = await bookedPatient(Q);
    await call(sid, "POST", "/api/payments", { appointmentId: a2, amount: 300 });
    await h.say(Q, "pay kar diya");
    expect((await h.kinds(Q)).at(-1)).toBe("PAYMENT_CLAIMED");
    await h.say(Q, "paid");
    expect((await h.kinds(Q)).at(-1)).not.toBe("PAYMENT_CLAIMED");
  });

  it("'delete my data' removes the patient's follow-ups and amounts due", async () => {
    await setUpi("drsharma@okicici");
    const P = nextPhone(); const apptId = await bookedPatient(P);
    const sid = "STAFF" as const;
    await call(sid, "POST", "/api/payments", { appointmentId: apptId, amount: 200 });
    await call(sid, "POST", "/api/followups", { appointmentId: apptId, dueDate: "2026-10-30" });
    await h.say(P, "delete my data");
    await h.tap(P, "erase:yes");
    expect(await h.db.patientAccount.count({ where: { phoneHash: phoneHash(P) } })).toBe(0);
    expect(await h.db.paymentDue.count()).toBe(0);
    expect(await h.db.followUp.count()).toBe(0);
  });
});
