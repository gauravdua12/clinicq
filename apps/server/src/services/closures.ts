import { decrypt } from "@clinicq/db";
import { copy as C, time as T } from "@clinicq/core";
import type { Ctx } from "../context";
import { cancelAppointment } from "./booking";
import { clinicInfo } from "./clinic";
import { audit, sendToAccount } from "./notify";
import { firstName } from "./patients";

// Clinic closures / "CLOSE TODAY": cancel affected bookings and tell each patient (CS-04, TR-04).

export async function affectedByClosure(ctx: Ctx, date: string, sessionId: string | null): Promise<number> {
  const info = await clinicInfo(ctx);
  return ctx.db.appointment.count({ where: closureWhere(ctx, info.doctor.id, date, sessionId) });
}

function closureWhere(ctx: Ctx, doctorId: string, date: string, sessionId: string | null) {
  return {
    doctorId, status: { in: ["BOOKED", "ARRIVED", "HELD"] as ("BOOKED" | "ARRIVED" | "HELD")[] },
    slotStart: { gte: T.toInstant(date, "00:00", ctx.tz), lt: T.toInstant(T.addDays(date, 1), "00:00", ctx.tz) },
    ...(sessionId ? { sessionId } : {}),
  };
}

export async function applyClosure(ctx: Ctx, opts: { date: string; sessionId: string | null; label?: string; actorId: string | null; onlyFuture?: boolean }): Promise<number> {
  const info = await clinicInfo(ctx);
  await ctx.db.closure.create({ data: { doctorId: info.doctor.id, date: T.dateToDb(opts.date), sessionId: opts.sessionId, label: opts.label ?? null, createdById: opts.actorId } });
  const appts = await ctx.db.appointment.findMany({ where: { ...closureWhere(ctx, info.doctor.id, opts.date, opts.sessionId), ...(opts.onlyFuture ? {} : {}) }, include: { profile: true } });
  let n = 0;
  for (const a of appts) {
    await cancelAppointment(ctx, a.id, "CLINIC", opts.actorId);
    n++;
    const accId = a.profile?.accountId;
    if (!accId || a.status === "HELD") continue;
    const acc = await ctx.db.patientAccount.findUniqueOrThrow({ where: { id: accId } });
    const vars = { name: firstName(decrypt(a.profile!.name)), date: T.fmtDayShort(opts.date, acc.language), time: T.fmtTime(T.localMinutes(a.slotStart, ctx.tz)), clinicPhone: info.clinic.phone };
    await sendToAccount(ctx, accId, { kind: "buttons", body: C.render("CANCELLED_BY_CLINIC", acc.language, vars), buttons: [{ id: "menu:book", title: C.btn("PICK_NEW_TIME", acc.language) }, { id: "call", title: C.btn("CALL_CLINIC", acc.language) }] },
      { kind: "CANCELLED_BY_CLINIC", template: { name: "cancelled_by_clinic", lang: acc.language, vars } });
  }
  // Walk-ins still waiting today are told too.
  if (opts.date === T.localDate(ctx.clock.now(), ctx.tz)) {
    const waiting = await ctx.db.queueEntry.findMany({ where: { doctorId: info.doctor.id, date: T.dateToDb(opts.date), state: { in: ["WAITING", "NEXT"] }, ...(opts.sessionId ? { sessionId: opts.sessionId } : {}) }, include: { profile: true } });
    for (const w of waiting) {
      await ctx.db.queueEntry.update({ where: { id: w.id }, data: { state: "CANCELLED", version: { increment: 1 } } });
      if (w.profile?.accountId && !w.appointmentId) {
        const acc = await ctx.db.patientAccount.findUniqueOrThrow({ where: { id: w.profile.accountId } });
        await sendToAccount(ctx, acc.id, { kind: "buttons", body: C.render("CANCELLED_BY_CLINIC", acc.language, { name: firstName(decrypt(w.profile.name)), date: T.fmtDayShort(opts.date, acc.language), time: "", clinicPhone: info.clinic.phone }), buttons: [{ id: "menu:book", title: C.btn("PICK_NEW_TIME", acc.language) }] }, { kind: "CANCELLED_BY_CLINIC" });
      }
      n++;
    }
  }
  await audit(ctx, "STAFF", opts.actorId, "closure.apply", "Closure", null, { date: opts.date, sessionId: opts.sessionId, affected: n });
  ctx.bus.publish({ type: "queue.updated", doctorId: info.doctor.id });
  return n;
}
