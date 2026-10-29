import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { decrypt, maskPhone, type FollowUp, type PaymentDue } from "@clinicq/db";
import { copy as C, time as T } from "@clinicq/core";
import type { Ctx } from "../context";
import { clinicInfo, nowLocal } from "./clinic";
import { audit, sendToAccount } from "./notify";
import { firstName } from "./patients";

// Follow-up reminders (docs/PRD.md FU-01, FU-02) and payment reminders (PR-01…PR-04): utility messages about one patient's
// own visit. Stored: who, which date, the amount and its status. Never why (no reasons, notes or diagnoses).

export class ReminderError extends Error {
  constructor(public code: "not_found" | "no_whatsapp" | "bad_date" | "no_upi" | "not_pending" | "too_soon") { super(code); }
}

export interface VisitRef { appointmentId?: string; queueEntryId?: string }
interface VisitPatient { profileId: string; accountId: string; name: string; visitDate: string }

/** The patient behind an appointment or a queue token (walk-ins too), if they're on WhatsApp. */
async function visitPatient(ctx: Ctx, ref: VisitRef): Promise<VisitPatient> {
  const info = await clinicInfo(ctx);
  if (ref.appointmentId) {
    const a = await ctx.db.appointment.findUnique({ where: { id: ref.appointmentId }, include: { profile: true } });
    if (!a || a.doctorId !== info.doctor.id) throw new ReminderError("not_found");
    if (!a.profile?.accountId) throw new ReminderError("no_whatsapp");
    return { profileId: a.profile.id, accountId: a.profile.accountId, name: decrypt(a.profile.name), visitDate: T.localDate(a.slotStart, ctx.tz) };
  }
  if (ref.queueEntryId) {
    const q = await ctx.db.queueEntry.findUnique({ where: { id: ref.queueEntryId }, include: { profile: true } });
    if (!q || q.doctorId !== info.doctor.id) throw new ReminderError("not_found");
    if (!q.profile?.accountId) throw new ReminderError("no_whatsapp");
    return { profileId: q.profile.id, accountId: q.profile.accountId, name: decrypt(q.profile.name), visitDate: T.dateFromDb(q.date) };
  }
  throw new ReminderError("not_found");
}

/** Reminders go out between 9 am and 8 pm clinic time: now if that's within those hours, else 10 am next. */
function sendableAt(ctx: Ctx, at: Date): Date {
  const min = T.localMinutes(at, ctx.tz);
  const day = T.localDate(at, ctx.tz);
  if (min >= 9 * 60 && min < 20 * 60) return at;
  return T.toInstant(min < 9 * 60 ? day : T.addDays(day, 1), "10:00", ctx.tz);
}

const rupees = (paise: number) => (paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });

// ── follow-ups ─────────────────────────────────────────────────

export async function createFollowUp(ctx: Ctx, ref: VisitRef, dueDate: string, actorId: string | null): Promise<{ id: string; dueDate: string; remindOn: string }> {
  const info = await clinicInfo(ctx);
  const today = nowLocal(ctx).date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || dueDate <= today || dueDate > T.addDays(today, 366)) throw new ReminderError("bad_date");
  const p = await visitPatient(ctx, ref);
  // One open follow-up per patient: a new date replaces the previous one.
  for (const old of await ctx.db.followUp.findMany({ where: { profileId: p.profileId, cancelledAt: null, remindedAt: null, bookedAppointmentId: null } })) {
    await ctx.db.followUp.update({ where: { id: old.id }, data: { cancelledAt: ctx.clock.now() } });
    await ctx.jobs.cancel(`fu:${old.id}`);
  }
  const fu = await ctx.db.followUp.create({ data: { profileId: p.profileId, doctorId: info.doctor.id, dueDate: T.dateToDb(dueDate), createdById: actorId } });
  const remindOn = T.addDays(dueDate, -info.settings.followUp.remindDaysBefore);
  const runAt = remindOn <= today ? sendableAt(ctx, ctx.clock.now()) : T.toInstant(remindOn, "10:00", ctx.tz);
  await ctx.jobs.schedule("followUpDue", { id: fu.id }, runAt, `fu:${fu.id}`);
  await audit(ctx, "STAFF", actorId, "followup.create", "FollowUp", fu.id, { dueDate });
  return { id: fu.id, dueDate, remindOn: T.localDate(runAt, ctx.tz) };
}

export async function cancelFollowUp(ctx: Ctx, id: string, actorId: string | null): Promise<void> {
  const info = await clinicInfo(ctx);
  const fu = await ctx.db.followUp.findUnique({ where: { id } });
  if (!fu || fu.doctorId !== info.doctor.id) throw new ReminderError("not_found");
  await ctx.db.followUp.update({ where: { id }, data: { cancelledAt: ctx.clock.now() } });
  await ctx.jobs.cancel(`fu:${id}`);
  await audit(ctx, "STAFF", actorId, "followup.cancel", "FollowUp", id);
}

/** The patient's next appointment from today up to two weeks after the due date: the follow-up is already booked. */
async function bookedFor(ctx: Ctx, fu: FollowUp): Promise<string | null> {
  const from = T.toInstant(nowLocal(ctx).date, "00:00", ctx.tz);
  const to = T.toInstant(T.addDays(T.dateFromDb(fu.dueDate), 15), "00:00", ctx.tz);
  const a = await ctx.db.appointment.findFirst({ where: { profileId: fu.profileId, status: { in: ["BOOKED", "ARRIVED", "COMPLETED"] }, slotStart: { gte: from, lt: to } }, orderBy: { slotStart: "asc" } });
  return a?.id ?? null;
}

export async function followUpDue(ctx: Ctx, id: string): Promise<void> {
  const fu = await ctx.db.followUp.findUnique({ where: { id }, include: { profile: true } });
  if (!fu || fu.cancelledAt || fu.remindedAt || fu.bookedAppointmentId || !fu.profile.accountId) return;
  const booked = await bookedFor(ctx, fu);
  if (booked) { await ctx.db.followUp.update({ where: { id }, data: { bookedAppointmentId: booked } }); return; }
  const info = await clinicInfo(ctx);
  const acc = await ctx.db.patientAccount.findUniqueOrThrow({ where: { id: fu.profile.accountId } });
  const lang = acc.language;
  const vars = { name: firstName(decrypt(fu.profile.name)), doctor: info.doctor.displayName, date: T.fmtDate(T.dateFromDb(fu.dueDate), lang), ref: fu.id };
  await sendToAccount(ctx, acc.id, { kind: "buttons", body: C.render("FOLLOWUP_DUE", lang, vars), buttons: [{ id: `fu:${fu.id}`, title: C.btn("BOOK", lang) }] },
    { kind: "FOLLOWUP_DUE", essential: false, template: { name: "followup_due", lang, vars } });
  await ctx.db.followUp.update({ where: { id }, data: { remindedAt: ctx.clock.now() } });
}

/** The patient tapped "Book" on a follow-up reminder: their profile, the due date (or today if it has passed). */
export async function followUpForBooking(ctx: Ctx, id: string, accountId: string): Promise<{ profileId: string; date: string } | null> {
  const fu = await ctx.db.followUp.findUnique({ where: { id }, include: { profile: true } });
  if (!fu || fu.cancelledAt || fu.bookedAppointmentId || fu.profile.accountId !== accountId) return null;
  const today = nowLocal(ctx).date;
  const due = T.dateFromDb(fu.dueDate);
  return { profileId: fu.profileId, date: due < today ? today : due };
}

/** A booking was confirmed for this profile: it fulfils their open follow-up if it's within a week before the due date or later. */
export async function linkFollowUp(ctx: Ctx, profileId: string, appointmentId: string, slotStart: Date): Promise<void> {
  const day = T.localDate(slotStart, ctx.tz);
  for (const fu of await ctx.db.followUp.findMany({ where: { profileId, cancelledAt: null, bookedAppointmentId: null } })) {
    if (day < T.addDays(T.dateFromDb(fu.dueDate), -7)) continue;
    await ctx.db.followUp.update({ where: { id: fu.id }, data: { bookedAppointmentId: appointmentId } });
    await ctx.jobs.cancel(`fu:${fu.id}`);
  }
}

export interface FollowUpView { id: string; name: string; phone: string; dueDate: string; status: "scheduled" | "reminded" | "booked"; remindedAt: string | null }

export async function listFollowUps(ctx: Ctx): Promise<FollowUpView[]> {
  const info = await clinicInfo(ctx);
  const since = T.dateToDb(T.addDays(nowLocal(ctx).date, -14));
  const rows = await ctx.db.followUp.findMany({ where: { doctorId: info.doctor.id, cancelledAt: null, dueDate: { gte: since } }, include: { profile: { include: { account: true } } }, orderBy: { dueDate: "asc" }, take: 200 });
  return rows.map((f) => ({
    id: f.id, name: decrypt(f.profile.name), phone: f.profile.account ? maskPhone(decrypt(f.profile.account.waPhone)) : "",
    dueDate: T.dateFromDb(f.dueDate), status: f.bookedAppointmentId ? "booked" : f.remindedAt ? "reminded" : "scheduled", remindedAt: f.remindedAt?.toISOString() ?? null,
  }));
}

// ── payments due ───────────────────────────────────────────────

export const payUrl = (ctx: Ctx, token: string) => `${ctx.env.PUBLIC_BASE_URL}${ctx.env.BASE_PATH}/pay?t=${token}`;

export async function createPaymentDue(ctx: Ctx, ref: VisitRef, amountRupees: number, actorId: string | null): Promise<{ id: string; whatsappSent: boolean }> {
  const info = await clinicInfo(ctx);
  if (!info.settings.paymentReminders.upiId) throw new ReminderError("no_upi");
  const p = await visitPatient(ctx, ref);
  const due = await ctx.db.paymentDue.create({ data: {
    profileId: p.profileId, doctorId: info.doctor.id, visitDate: T.dateToDb(p.visitDate), amountPaise: Math.round(amountRupees * 100),
    payToken: randomBytes(9).toString("base64url"), createdById: actorId,
  } });
  await audit(ctx, "STAFF", actorId, "payment_due.create", "PaymentDue", due.id, { amountPaise: due.amountPaise });
  const sent = await sendPaymentReminder(ctx, due.id);
  return { id: due.id, whatsappSent: sent };
}

/** Sends the "payment pending" message now, and schedules the next reminder while reminders remain. */
export async function sendPaymentReminder(ctx: Ctx, id: string, manual = false): Promise<boolean> {
  const info = await clinicInfo(ctx);
  const due = await ctx.db.paymentDue.findUnique({ where: { id }, include: { profile: true } });
  if (!due || due.doctorId !== info.doctor.id) throw new ReminderError("not_found");
  if (due.status !== "PENDING") throw new ReminderError("not_pending");
  if (!due.profile.accountId) throw new ReminderError("no_whatsapp");
  const now = ctx.clock.now();
  if (manual && due.lastRemindedAt && now.getTime() - due.lastRemindedAt.getTime() < 12 * 3600_000) throw new ReminderError("too_soon");
  const acc = await ctx.db.patientAccount.findUniqueOrThrow({ where: { id: due.profile.accountId } });
  const lang = acc.language;
  const vars = { name: firstName(decrypt(due.profile.name)), amount: rupees(due.amountPaise), clinicName: info.clinic.name, date: T.fmtDate(T.dateFromDb(due.visitDate), lang), payToken: due.payToken };
  const sent = await sendToAccount(ctx, acc.id, { kind: "cta_url", body: C.render("PAYMENT_DUE", lang, vars), displayText: C.btn("PAY_NOW", lang), url: payUrl(ctx, due.payToken) },
    { kind: "PAYMENT_DUE", essential: false, template: { name: "payment_due", lang, vars } });
  const n = due.remindersSent + 1;
  await ctx.db.paymentDue.update({ where: { id }, data: { remindersSent: n, lastRemindedAt: now } });
  const cfg = info.settings.paymentReminders;
  await ctx.jobs.cancel(`pay:${id}`);
  if (n <= cfg.maxReminders) {
    const next = T.toInstant(T.addDays(T.localDate(now, ctx.tz), cfg.remindEveryDays), "11:00", ctx.tz);
    await ctx.jobs.schedule("paymentRemind", { id }, next, `pay:${id}`);
  }
  return sent;
}

export async function paymentRemindJob(ctx: Ctx, id: string): Promise<void> {
  const due = await ctx.db.paymentDue.findUnique({ where: { id } });
  if (!due || due.status !== "PENDING" || due.claimedPaidAt) return;
  await sendPaymentReminder(ctx, id).catch((e) => ctx.log.warn({ err: e, id }, "payment_reminder_skipped"));
}

export async function markPaid(ctx: Ctx, id: string, actorId: string | null): Promise<{ whatsappSent: boolean }> {
  const info = await clinicInfo(ctx);
  const due = await ctx.db.paymentDue.findUnique({ where: { id }, include: { profile: true } });
  if (!due || due.doctorId !== info.doctor.id) throw new ReminderError("not_found");
  if (due.status !== "PENDING") throw new ReminderError("not_pending");
  await ctx.db.paymentDue.update({ where: { id }, data: { status: "PAID", paidAt: ctx.clock.now() } });
  await ctx.jobs.cancel(`pay:${id}`);
  await audit(ctx, "STAFF", actorId, "payment_due.paid", "PaymentDue", id);
  if (!due.profile.accountId) return { whatsappSent: false };
  const acc = await ctx.db.patientAccount.findUniqueOrThrow({ where: { id: due.profile.accountId } });
  const vars = { name: firstName(decrypt(due.profile.name)), amount: rupees(due.amountPaise), date: T.fmtDate(T.dateFromDb(due.visitDate), acc.language) };
  const sent = await sendToAccount(ctx, acc.id, { kind: "text", body: C.render("PAYMENT_RECEIVED", acc.language, vars) },
    { kind: "PAYMENT_RECEIVED", template: { name: "payment_received", lang: acc.language, vars } });
  return { whatsappSent: sent };
}

export async function cancelPaymentDue(ctx: Ctx, id: string, actorId: string | null): Promise<void> {
  const info = await clinicInfo(ctx);
  const due = await ctx.db.paymentDue.findUnique({ where: { id } });
  if (!due || due.doctorId !== info.doctor.id) throw new ReminderError("not_found");
  if (due.status !== "PENDING") throw new ReminderError("not_pending");
  await ctx.db.paymentDue.update({ where: { id }, data: { status: "CANCELLED" } });
  await ctx.jobs.cancel(`pay:${id}`);
  await audit(ctx, "STAFF", actorId, "payment_due.cancel", "PaymentDue", id);
}

/** The patient says they've paid ("paid", "payment done", "pay kar diya"): note it for staff to check, stop reminders. */
export async function claimPaid(ctx: Ctx, accountId: string): Promise<PaymentDue | null> {
  const due = await ctx.db.paymentDue.findFirst({ where: { status: "PENDING", claimedPaidAt: null, profile: { accountId } }, orderBy: { createdAt: "desc" }, include: { profile: true } });
  if (!due) return null;
  await ctx.db.paymentDue.update({ where: { id: due.id }, data: { claimedPaidAt: ctx.clock.now() } });
  await ctx.jobs.cancel(`pay:${due.id}`);
  ctx.bus.publish({ type: "payment.claimed", id: due.id, name: decrypt(due.profile.name), amount: rupees(due.amountPaise) });
  return due;
}

export const amountText = rupees;

export interface PaymentView { id: string; name: string; phone: string; visitDate: string; amount: number; status: string; remindersSent: number; lastRemindedAt: string | null; claimedPaid: boolean; paidAt: string | null }

export async function listPayments(ctx: Ctx): Promise<PaymentView[]> {
  const info = await clinicInfo(ctx);
  const since = new Date(ctx.clock.now().getTime() - 30 * 86_400_000);
  const rows = await ctx.db.paymentDue.findMany({
    where: { doctorId: info.doctor.id, OR: [{ status: "PENDING" }, { paidAt: { gte: since } }] },
    include: { profile: { include: { account: true } } }, orderBy: [{ status: "asc" }, { createdAt: "desc" }], take: 200,
  });
  return rows.map((d) => ({
    id: d.id, name: decrypt(d.profile.name), phone: d.profile.account ? maskPhone(decrypt(d.profile.account.waPhone)) : "",
    visitDate: T.dateFromDb(d.visitDate), amount: d.amountPaise / 100, status: d.status, remindersSent: d.remindersSent,
    lastRemindedAt: d.lastRemindedAt?.toISOString() ?? null, claimedPaid: !!d.claimedPaidAt, paidAt: d.paidAt?.toISOString() ?? null,
  }));
}

/** Public pay page (no login): only what's needed to pay. No patient name, so a forwarded link reveals nothing personal. */
export async function payPage(ctx: Ctx, token: string): Promise<Record<string, unknown> | null> {
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(token)) return null;
  const due = await ctx.db.paymentDue.findUnique({ where: { payToken: token } });
  if (!due || due.status === "CANCELLED") return null;
  const info = await clinicInfo(ctx);
  const cfg = info.settings.paymentReminders;
  const amount = (due.amountPaise / 100).toFixed(2);
  const upi = cfg.upiId
    ? `upi://pay?${new URLSearchParams({ pa: cfg.upiId, pn: cfg.payeeName || info.clinic.name, am: amount, cu: "INR", tn: `Visit ${T.fmtDayShort(T.dateFromDb(due.visitDate), "en")}` }).toString()}`
    : null;
  return {
    clinicName: info.clinic.name, clinicPhone: info.clinic.phone, addressShort: info.clinic.addressShort,
    amount: rupees(due.amountPaise), visitDate: T.fmtDate(T.dateFromDb(due.visitDate), "en"), status: due.status,
    upiId: cfg.upiId || null, payeeName: cfg.payeeName || info.clinic.name, upiLink: upi, qr: upi ? await QRCode.toDataURL(upi, { margin: 1, width: 360 }) : null,
  };
}
