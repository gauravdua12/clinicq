import type { Clinic, Doctor, Session } from "@clinicq/db";
import { slots as S, time as T } from "@clinicq/core";
import type { Ctx } from "../context";
import { currentScope } from "../scope";
import { parseSettings, type ClinicSettings } from "../settings";

// One doctor per clinic (doctorId is everywhere, so a second doctor is a later UI change). Several clinics: src/scope.ts.

export interface ClinicInfo {
  clinic: Clinic;
  doctor: Doctor;
  sessions: Session[];
  settings: ClinicSettings;
}

const cache = new Map<string, { at: number; info: ClinicInfo }>();

export function invalidateClinicCache(): void { cache.clear(); }

/**
 * The clinic of the current scope (src/scope.ts): a customer clinic on its own number, or, on the shared demo number,
 * the active clinic (a demo can be switched in via Demo Studio; else the first clinic).
 */
export async function clinicInfo(ctx: Ctx): Promise<ClinicInfo> {
  const scoped = currentScope().clinicId;
  const key = scoped ?? "";
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 5_000) {
    // cheap re-validation: the cached clinic/doctor must still exist (DB may have been changed by another process)
    const alive = await ctx.db.doctor.findUnique({ where: { id: hit.info.doctor.id }, select: { id: true } });
    if (alive) return hit.info;
    cache.delete(key);
  }
  let clinic: Clinic | null = null;
  if (scoped) clinic = await ctx.db.clinic.findUnique({ where: { id: scoped } });
  else {
    const active = await ctx.db.systemConfig.findUnique({ where: { key: "activeClinicId" } });
    const activeId = typeof active?.value === "string" ? active.value : null;
    clinic = (activeId ? await ctx.db.clinic.findFirst({ where: { id: activeId, ownNumber: false } }) : null)
      ?? (await ctx.db.clinic.findFirst({ where: { ownNumber: false }, orderBy: { createdAt: "asc" } }));
  }
  if (!clinic) throw new Error(scoped ? "clinic_not_found" : "no_clinic");
  const doctor = await ctx.db.doctor.findFirstOrThrow({ where: { clinicId: clinic.id } });
  const sessions = await ctx.db.session.findMany({ where: { doctorId: doctor.id, active: true } });
  const info = { clinic, doctor, sessions, settings: parseSettings(clinic.settings) };
  cache.set(key, { at: Date.now(), info });
  return info;
}

export function sessionDefs(sessions: Session[]): S.SessionDef[] {
  return sessions.map((s) => ({ id: s.id, weekday: s.weekday, label: s.label, startTime: s.startTime, endTime: s.endTime, slotMinutes: s.slotMinutes, maxSlots: s.maxSlots, walkinQuota: s.walkinQuota, active: s.active }));
}

export function nowLocal(ctx: Ctx): { date: string; min: number; time: string } {
  const now = ctx.clock.now();
  return { date: T.localDate(now, ctx.tz), min: T.localMinutes(now, ctx.tz), time: T.localTime(now, ctx.tz) };
}

/** Availability snapshot for a date range (inclusive), reading appointments, holds, blocks, closures. */
export async function availability(ctx: Ctx, info: ClinicInfo, from: string, to: string): Promise<S.AvailabilityInput> {
  const n = nowLocal(ctx);
  const start = T.toInstant(from, "00:00", ctx.tz);
  const end = T.toInstant(T.addDays(to, 1), "00:00", ctx.tz);
  const [appts, blocks, closures] = await Promise.all([
    ctx.db.appointment.findMany({ where: { doctorId: info.doctor.id, slotKey: { not: null }, slotStart: { gte: start, lt: end } }, select: { slotStart: true, status: true, holdExpiresAt: true } }),
    ctx.db.blockedSlot.findMany({ where: { doctorId: info.doctor.id, slotStart: { gte: start, lt: end } } }),
    ctx.db.closure.findMany({ where: { doctorId: info.doctor.id, date: { gte: T.dateToDb(from), lte: T.dateToDb(to) } } }),
  ]);
  const now = ctx.clock.now();
  const ref = (d: Date) => S.slotRef(T.localDate(d, ctx.tz), T.localMinutes(d, ctx.tz));
  return {
    nowDate: n.date,
    nowMin: n.min,
    sessions: sessionDefs(info.sessions),
    closures: closures.map((c) => ({ date: T.dateFromDb(c.date), sessionId: c.sessionId })),
    taken: new Set(appts.filter((a) => a.status !== "HELD" || (a.holdExpiresAt && a.holdExpiresAt > now)).map((a) => ref(a.slotStart))),
    blocked: new Set(blocks.map((b) => ref(b.slotStart))),
    rules: { windowDays: info.settings.windowDays, cutoffMinutes: info.settings.cutoffMinutes, nearWindowMinutes: info.settings.nearWindowMinutes },
  };
}

export async function windowAvailability(ctx: Ctx, info: ClinicInfo): Promise<S.AvailabilityInput> {
  const n = nowLocal(ctx);
  return availability(ctx, info, n.date, T.addDays(n.date, info.settings.windowDays + 1));
}

export function slotInstant(ctx: Ctx, slot: { date: string; startMin: number }): Date {
  return T.toInstant(slot.date, slot.startMin, ctx.tz);
}

export function slotKey(doctorId: string, at: Date): string {
  return `${doctorId}:${at.toISOString()}`;
}

/** Session instance "running" now: from 60 min before start until 60 min after end. */
export function currentSession(ctx: Ctx, info: ClinicInfo): { session: Session; date: string } | null {
  const n = nowLocal(ctx);
  const closed = false;
  const today = info.sessions
    .filter((s) => s.weekday === T.weekdayOf(n.date))
    .sort((a, b) => T.toMin(a.startTime) - T.toMin(b.startTime));
  const hit = today.find((s) => n.min >= T.toMin(s.startTime) - 60 && n.min <= T.toMin(s.endTime) + 60);
  return hit && !closed ? { session: hit, date: n.date } : null;
}

export function sessionForSlot(info: ClinicInfo, sessionId: string): Session | undefined {
  return info.sessions.find((s) => s.id === sessionId);
}

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Mon–Sat 10:00 AM–1:00 PM, 5:00 PM–8:00 PM; closed Sun" */
export function sessionsText(info: ClinicInfo): string {
  const byWindow = new Map<string, number[]>();
  for (const s of info.sessions) {
    const k = `${T.fmtTime(s.startTime)}–${T.fmtTime(s.endTime)}`;
    byWindow.set(k, [...(byWindow.get(k) ?? []), s.weekday]);
  }
  const daysStr = (ds: number[]) => {
    const u = [...new Set(ds)].sort();
    const contiguous = u.every((d, i) => i === 0 || d === u[i - 1]! + 1);
    return contiguous && u.length > 2 ? `${WD[u[0]!]}–${WD[u.at(-1)!]}` : u.map((d) => WD[d]).join(", ");
  };
  const parts = [...byWindow.entries()].map(([w, ds]) => `${daysStr(ds)} ${w}`);
  const open = new Set(info.sessions.map((s) => s.weekday));
  const closed = [0, 1, 2, 3, 4, 5, 6].filter((d) => !open.has(d)).map((d) => WD[d]);
  return parts.join(", ") + (closed.length ? `; closed ${closed.join(", ")}` : "");
}

export function sessionHours(info: ClinicInfo): string {
  const uniq = [...new Set(info.sessions.map((s) => `${T.fmtTime(s.startTime)}–${T.fmtTime(s.endTime)}`))];
  return uniq.join(", ");
}

export function mapsLine(info: ClinicInfo): string {
  return info.clinic.mapsUrl ? `\n${info.clinic.mapsUrl}` : "";
}
