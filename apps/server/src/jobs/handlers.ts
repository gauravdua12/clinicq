import { decrypt } from "@clinicq/db";
import { copy as C, time as T } from "@clinicq/core";
import type { Ctx } from "../context";
import { clinicInfo, mapsLine, nowLocal } from "../services/clinic";
import { sendToAccount } from "../services/notify";
import { firstName } from "../services/patients";
import { arriveAppointment } from "../services/queue";
import { followUpDue, paymentRemindJob } from "../services/reminders";
import { checkConnection, submitTemplates } from "../services/embeddedSignup";
import { currentScope } from "../scope";
import { overflowTimeout } from "../services/walkin";

// Scheduled jobs (docs/ARCHITECTURE.md §5). Payloads carry IDs only.

export function registerJobs(ctx: Ctx): void {
  const j = ctx.jobs;

  j.on("reminder24", async ({ apptId }) => reminder(ctx, String(apptId), "24h"));
  j.on("reminderDay", async ({ apptId }) => reminder(ctx, String(apptId), "day"));

  j.on("noShowCheck", async ({ apptId }) => {
    const a = await ctx.db.appointment.findUnique({ where: { id: String(apptId) }, include: { profile: true } });
    if (!a || a.status !== "BOOKED") return;
    await ctx.db.appointment.update({ where: { id: a.id }, data: { status: "NO_SHOW", slotKey: null } });
    await ctx.db.auditLog.create({ data: { actorType: "SYSTEM", action: "appointment.no_show", entity: "Appointment", entityId: a.id } });
    const accId = a.profile?.accountId;
    if (!accId) return;
    const acc = await ctx.db.patientAccount.findUniqueOrThrow({ where: { id: accId } });
    const name = firstName(decrypt(a.profile!.name));
    await sendToAccount(ctx, accId, { kind: "buttons", body: C.render("NO_SHOW_MISSED", acc.language, { name }), buttons: [{ id: "menu:book", title: C.btn("BOOK_AGAIN", acc.language) }] },
      { kind: "NO_SHOW_MISSED", essential: false, template: { name: "no_show_rebook", lang: acc.language, vars: { name } } });
  });

  j.on("earlyCheckIn", async ({ apptId }) => {
    const a = await ctx.db.appointment.findUnique({ where: { id: String(apptId) } });
    if (a?.status === "BOOKED") await arriveAppointment(ctx, a.id, { type: "SYSTEM", id: null });
  });

  j.on("followUpDue", async ({ id }) => followUpDue(ctx, String(id)));
  j.on("paymentRemind", async ({ id }) => paymentRemindJob(ctx, String(id)));

  // A customer clinic just connected its number: submit its templates, then check their approval a few times.
  j.on("waTemplates", async () => {
    const r = await submitTemplates(ctx);
    ctx.log.info({ created: r.created, failed: r.failed.length }, "wa_templates_submitted");
    const now = ctx.clock.now().getTime();
    for (const min of [10, 60, 24 * 60]) await j.schedule("waCheck", {}, new Date(now + min * 60_000), `wa-check:${currentScope().clinicId}:${min}`);
  });
  j.on("waCheck", async () => { await checkConnection(ctx); });

  j.on("overflowTimeout", async ({ requestId }) => overflowTimeout(ctx, String(requestId)));

  j.on("purge", async () => { await purge(ctx); });

  // Every poll: release expired holds; make sure today's purge is scheduled.
  j.onTick(async () => {
    const now = ctx.clock.now();
    await ctx.db.appointment.updateMany({ where: { status: "HELD", holdExpiresAt: { lte: now } }, data: { status: "CANCELLED", slotKey: null, cancelledBy: "SYSTEM", cancelledAt: now } });
    const d = nowLocal(ctx).date;
    await j.ensure("purge", {}, T.toInstant(T.addDays(d, 1), "02:30", ctx.tz), `purge:${T.addDays(d, 1)}`);
  });
}

async function reminder(ctx: Ctx, apptId: string, kind: "24h" | "day"): Promise<void> {
  const info = await clinicInfo(ctx);
  const a = await ctx.db.appointment.findUnique({ where: { id: apptId }, include: { profile: true } });
  if (!a || a.status !== "BOOKED" || !a.profile?.accountId) return;
  if ((kind === "24h" && a.reminder24Sent) || (kind === "day" && a.reminderDaySent)) return;
  const acc = await ctx.db.patientAccount.findUniqueOrThrow({ where: { id: a.profile.accountId } });
  const lang = acc.language;
  const doc = await ctx.db.doctor.findUniqueOrThrow({ where: { id: info.doctor.id } });
  const today = nowLocal(ctx).date;
  const late = doc.delayDate && T.dateFromDb(doc.delayDate) === today ? doc.delayMinutes : 0;
  const vars = {
    name: firstName(decrypt(a.profile.name)), doctor: info.doctor.displayName, dayShort: T.fmtDayShort(T.localDate(a.slotStart, ctx.tz), lang),
    time: T.fmtTime(T.localMinutes(a.slotStart, ctx.tz)), token: a.token ?? "", addressShort: info.clinic.addressShort, mapsLine: mapsLine(info),
    runningStatus: late ? C.render("RUNNING_LATE", lang, { min: late }) : C.render("RUNNING_ON_TIME", lang), apptId: a.id,
  };
  if (kind === "24h") {
    await sendToAccount(ctx, acc.id, { kind: "buttons", body: C.render("REMINDER_24H", lang, vars), buttons: [
      { id: `appt:ok:${a.id}`, title: C.btn("CONFIRM", lang) }, { id: `appt:rs:${a.id}`, title: C.btn("RESCHEDULE", lang) }, { id: `appt:cx:${a.id}`, title: C.btn("CANCEL", lang) },
    ] }, { kind: "REMINDER_24H", essential: false, template: { name: "reminder_24h", lang, vars } });
    await ctx.db.appointment.update({ where: { id: a.id }, data: { reminder24Sent: true } });
  } else {
    await sendToAccount(ctx, acc.id, { kind: "buttons", body: C.render("REMINDER_SAME_DAY", lang, vars), buttons: [{ id: `appt:cx:${a.id}`, title: C.btn("CANCEL", lang) }] },
      { kind: "REMINDER_SAME_DAY", essential: false, template: { name: "reminder_same_day", lang, vars } });
    await ctx.db.appointment.update({ where: { id: a.id }, data: { reminderDaySent: true } });
  }
}

/** Retention (docs/DATA_POLICY.md §5). */
export async function purge(ctx: Ctx): Promise<Record<string, number>> {
  const info = await clinicInfo(ctx);
  const r = info.settings.retention;
  const now = ctx.clock.now().getTime();
  const day = 86_400_000;
  const out: Record<string, number> = {};
  out.messageLog = (await ctx.db.messageLog.deleteMany({ where: { createdAt: { lt: new Date(now - r.messageLogDays * day) } } })).count;
  out.conversation = (await ctx.db.conversationState.deleteMany({ where: { expiresAt: { lt: new Date(now - day) } } })).count;
  out.flowTokens = (await ctx.db.flowToken.deleteMany({ where: { expiresAt: { lt: new Date(now) } } })).count;
  out.processed = (await ctx.db.processedMessage.deleteMany({ where: { receivedAt: { lt: new Date(now - 7 * day) } } })).count;
  const visitCut = new Date(now - r.visitAnonymiseDays * day);
  out.visits = (await ctx.db.appointment.updateMany({ where: { slotStart: { lt: visitCut }, profileId: { not: null } }, data: { profileId: null } })).count;
  out.queue = (await ctx.db.queueEntry.updateMany({ where: { arrivedAt: { lt: visitCut }, OR: [{ profileId: { not: null } }, { displayName: { not: null } }] }, data: { profileId: null, displayName: null } })).count;
  const inactiveCut = new Date(now - r.inactiveProfileMonths * 30 * day);
  out.accounts = (await ctx.db.patientAccount.deleteMany({ where: { lastActivityAt: { lt: inactiveCut } } })).count;
  out.followUps = (await ctx.db.followUp.deleteMany({ where: { dueDate: { lt: visitCut } } })).count;
  out.paymentsDue = (await ctx.db.paymentDue.deleteMany({ where: { status: { not: "PENDING" }, visitDate: { lt: visitCut } } })).count;
  out.audit = (await ctx.db.auditLog.deleteMany({ where: { at: { lt: new Date(now - r.auditDays * day) } } })).count;
  out.jobs = (await ctx.db.scheduledJob.deleteMany({ where: { doneAt: { lt: new Date(now - 7 * day) } } })).count;
  // A clinic that disconnected its WhatsApp: its account and number ids go 30 days later (the token went at once).
  out.waConnections = (await ctx.db.waConnection.deleteMany({ where: { status: "DISCONNECTED", checkedAt: { lt: new Date(now - 30 * day) } } })).count;
  out.otp = (await ctx.db.otpChallenge.deleteMany({ where: { expiresAt: { lt: new Date(now) } } })).count;
  out.sessions = (await ctx.db.staffSession.deleteMany({ where: { expiresAt: { lt: new Date(now) } } })).count;
  ctx.log.info({ purge: out }, "purge_done");
  return out;
}
