import { Prisma, decrypt, type Appointment, type VisitType } from "@clinicq/db";
import { slots as S, time as T } from "@clinicq/core";
import type { Ctx } from "../context";
import { linkFollowUp } from "./reminders";
import { clinicInfo, sessionForSlot, slotInstant, slotKey, type ClinicInfo } from "./clinic";
import { audit } from "./notify";

// Holds, confirmation, tokens, cancel, reschedule (docs/QUEUE_ENGINE.md §2.4–3).

export class SlotTakenError extends Error { constructor() { super("slot_taken"); } }
export class FamilySlotError extends Error { constructor(public otherProfileId: string) { super("family_same_slot"); } }

function isUnique(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

export async function allocateToken(tx: Prisma.TransactionClient, doctorId: string, date: string, sessionId: string, series: string): Promise<number> {
  const rows = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO "TokenCounter" ("doctorId","date","sessionId","series","value") VALUES (${doctorId}, ${T.dateToDb(date)}, ${sessionId}, ${series}, 1)
    ON CONFLICT ("doctorId","date","sessionId","series") DO UPDATE SET "value" = "TokenCounter"."value" + 1
    RETURNING "value"`;
  return rows[0]!.value;
}

/** Place a short hold on a slot (one booking per slot, always — even within a family). */
export async function holdSlot(ctx: Ctx, slot: S.Slot, profileId: string, accountId: string | null, minutes?: number): Promise<Appointment> {
  const info = await clinicInfo(ctx);
  const at = slotInstant(ctx, slot);
  const key = slotKey(info.doctor.id, at);
  const now = ctx.clock.now();
  const holdMin = minutes ?? info.settings.holdMinutes;
  // Same account already holding/booking it (another family member) → family path.
  const existing = await ctx.db.appointment.findUnique({ where: { slotKey: key }, include: { profile: { select: { accountId: true } } } });
  if (existing) {
    const expiredHold = existing.status === "HELD" && existing.holdExpiresAt && existing.holdExpiresAt <= now;
    if (!expiredHold) {
      if (existing.profileId === profileId && existing.status === "HELD") return ctx.db.appointment.update({ where: { id: existing.id }, data: { holdExpiresAt: new Date(now.getTime() + holdMin * 60_000) } });
      if (accountId && existing.profile?.accountId === accountId && existing.profileId) throw new FamilySlotError(existing.profileId);
      throw new SlotTakenError();
    }
  }
  try {
    return await ctx.db.$transaction(async (tx) => {
      await tx.appointment.updateMany({ where: { slotKey: key, status: "HELD", holdExpiresAt: { lte: now } }, data: { slotKey: null, status: "CANCELLED", cancelledBy: "SYSTEM", cancelledAt: now } });
      return tx.appointment.create({
        data: { doctorId: info.doctor.id, profileId, sessionId: slot.sessionId, slotStart: at, slotKey: key, status: "HELD", holdExpiresAt: new Date(now.getTime() + holdMin * 60_000) },
      });
    });
  } catch (e) {
    if (isUnique(e)) throw new SlotTakenError();
    throw e;
  }
}

export async function appointmentToken(ctx: Ctx, info: ClinicInfo, appt: Appointment, tx: Prisma.TransactionClient): Promise<string> {
  const ts = info.settings.tokenSeries;
  const date = T.localDate(appt.slotStart, ctx.tz);
  if (ts.singleSeries) return String(await allocateToken(tx, info.doctor.id, date, appt.sessionId, "N"));
  if (ts.appointmentTokenMode === "sequential") return `${ts.appointmentPrefix}-${await allocateToken(tx, info.doctor.id, date, appt.sessionId, "A")}`;
  const sess = sessionForSlot(info, appt.sessionId);
  const idx = sess ? S.generateSlots(date, { id: sess.id, weekday: sess.weekday, label: sess.label, startTime: sess.startTime, endTime: sess.endTime, slotMinutes: sess.slotMinutes, maxSlots: sess.maxSlots, walkinQuota: sess.walkinQuota })
    .findIndex((s) => s.startMin === T.localMinutes(appt.slotStart, ctx.tz)) : -1;
  return `${ts.appointmentPrefix}-${idx + 1}`;
}

/** HELD → BOOKED; allocates the token and schedules reminders. Throws SlotTakenError if the hold was lost. */
export async function confirmHold(ctx: Ctx, apptId: string, visitType: VisitType | null, source: "WHATSAPP" | "STAFF" = "WHATSAPP"): Promise<Appointment> {
  const info = await clinicInfo(ctx);
  const now = ctx.clock.now();
  let appt = await ctx.db.appointment.findUniqueOrThrow({ where: { id: apptId } });
  if (appt.status === "BOOKED") return appt;
  if (appt.status !== "HELD") throw new SlotTakenError();
  if (!appt.slotKey) {
    // swept — try to re-acquire the same slot
    try {
      appt = await ctx.db.appointment.update({ where: { id: apptId }, data: { slotKey: slotKey(info.doctor.id, appt.slotStart), status: "HELD", cancelledAt: null, cancelledBy: null } });
    } catch (e) { if (isUnique(e)) throw new SlotTakenError(); throw e; }
  }
  const booked = await ctx.db.$transaction(async (tx) => {
    const token = await appointmentToken(ctx, info, appt, tx);
    return tx.appointment.update({ where: { id: apptId }, data: { status: "BOOKED", holdExpiresAt: null, visitType, token, bookedAt: now, source } });
  });
  await scheduleAppointmentJobs(ctx, info, booked);
  if (booked.profileId) await linkFollowUp(ctx, booked.profileId, booked.id, booked.slotStart);
  await audit(ctx, source === "STAFF" ? "STAFF" : "PATIENT", null, "appointment.book", "Appointment", booked.id, { slotStart: booked.slotStart.toISOString(), token: booked.token });
  ctx.bus.publish({ type: "appointment.changed", id: booked.id, status: booked.status });
  return booked;
}

export async function scheduleAppointmentJobs(ctx: Ctx, info: ClinicInfo, a: Appointment): Promise<void> {
  const now = ctx.clock.now().getTime();
  const start = a.slotStart.getTime();
  const r24 = start - 24 * 3600_000;
  if (r24 > now + 30 * 60_000) await ctx.jobs.schedule("reminder24", { apptId: a.id }, new Date(r24), `r24:${a.id}`);
  const rDay = start - 2 * 3600_000;
  if (rDay > now) await ctx.jobs.schedule("reminderDay", { apptId: a.id }, new Date(rDay), `rday:${a.id}`);
  const sess = sessionForSlot(info, a.sessionId);
  if (sess) {
    const end = T.toInstant(T.localDate(a.slotStart, ctx.tz), sess.endTime, ctx.tz).getTime() + info.settings.noShowGraceMinutes * 60_000;
    await ctx.jobs.schedule("noShowCheck", { apptId: a.id }, new Date(end), `noshow:${a.id}`);
  }
}

export async function cancelAppointmentJobs(ctx: Ctx, apptId: string): Promise<void> {
  for (const p of ["r24", "rday", "noshow", "early"]) await ctx.jobs.cancel(`${p}:${apptId}`);
}

export async function releaseHold(ctx: Ctx, apptId: string): Promise<void> {
  await ctx.db.appointment.updateMany({ where: { id: apptId, status: "HELD" }, data: { status: "CANCELLED", slotKey: null, cancelledAt: ctx.clock.now(), cancelledBy: "SYSTEM" } });
}

export async function cancelAppointment(ctx: Ctx, apptId: string, by: "PATIENT" | "CLINIC" | "SYSTEM", actorId: string | null = null): Promise<Appointment> {
  const now = ctx.clock.now();
  const a = await ctx.db.appointment.update({ where: { id: apptId }, data: { status: "CANCELLED", slotKey: null, cancelledAt: now, cancelledBy: by, version: { increment: 1 } } });
  await ctx.db.queueEntry.updateMany({ where: { appointmentId: apptId, state: { in: ["WAITING", "NEXT"] } }, data: { state: "CANCELLED", version: { increment: 1 } } });
  await cancelAppointmentJobs(ctx, apptId);
  await audit(ctx, by === "CLINIC" ? "STAFF" : by, actorId, "appointment.cancel", "Appointment", apptId);
  ctx.bus.publish({ type: "appointment.changed", id: apptId, status: "CANCELLED" });
  ctx.bus.publish({ type: "queue.updated", doctorId: a.doctorId });
  return a;
}

/** Book the new held slot and cancel the old appointment, keeping visit type. */
export async function reschedule(ctx: Ctx, oldId: string, newHeldId: string): Promise<{ booked: Appointment; old: Appointment }> {
  const old = await ctx.db.appointment.findUniqueOrThrow({ where: { id: oldId } });
  const booked = await confirmHold(ctx, newHeldId, old.visitType);
  await ctx.db.appointment.update({ where: { id: booked.id }, data: { rescheduledFromId: old.id } });
  const cancelled = await cancelAppointment(ctx, oldId, "PATIENT");
  return { booked, old: cancelled };
}

export interface UpcomingView { id: string; profileId: string; profileName: string; slotStart: Date; token: string | null; status: string; visitType: VisitType | null }

export async function upcomingForAccount(ctx: Ctx, accountId: string): Promise<UpcomingView[]> {
  const info = await clinicInfo(ctx);
  const todayStart = T.toInstant(T.localDate(ctx.clock.now(), ctx.tz), "00:00", ctx.tz);
  const rows = await ctx.db.appointment.findMany({
    where: { doctorId: info.doctor.id, status: { in: ["BOOKED", "ARRIVED"] }, slotStart: { gte: todayStart }, profile: { accountId } },
    include: { profile: true },
    orderBy: { slotStart: "asc" },
  });
  return rows.map((r) => ({ id: r.id, profileId: r.profileId!, profileName: decrypt(r.profile!.name), slotStart: r.slotStart, token: r.token, status: r.status, visitType: r.visitType }));
}

export async function activeCountForProfile(ctx: Ctx, profileId: string): Promise<number> {
  const info = await clinicInfo(ctx);
  return ctx.db.appointment.count({ where: { doctorId: info.doctor.id, profileId, status: { in: ["BOOKED"] }, slotStart: { gte: ctx.clock.now() } } });
}
