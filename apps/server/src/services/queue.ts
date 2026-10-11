import { decrypt, encrypt, type QueueEntry, type Session } from "@clinicq/db";
import { copy as C, queue as Q, time as T } from "@clinicq/core";
import type { Ctx } from "../context";
import { allocateToken } from "./booking";
import { clinicInfo, currentSession, invalidateClinicCache, nowLocal, type ClinicInfo } from "./clinic";
import { audit, sendToAccount } from "./notify";
import { firstName } from "./patients";

// Live queue operations (docs/QUEUE_ENGINE.md §4). Every change: transaction → audit → SSE → alerts.

export class StaleError extends Error { constructor() { super("stale"); } }

// All queue mutations for a doctor run one at a time (single-process server): no lost updates,
// no double-advance when "Consultation completed" is tapped twice.
const locks = new Map<string, Promise<unknown>>();
export async function withQueueLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chained = prev.then(() => mine);
  locks.set(key, chained);
  await prev.catch(() => undefined);
  try { return await fn(); } finally { release(); if (locks.get(key) === chained) locks.delete(key); }
}
const LOCK = "queue";

type EntryRow = QueueEntry & { profile: { name: string; accountId: string | null } | null };

export interface EntryView {
  id: string; token: string; source: "A" | "W"; state: string; name: string; firstName: string;
  arrivedAt: string; slotStart: string | null; expectedAt: string | null; lateArrival: boolean; etaMin: number | null; ahead: number | null;
  version: number; hasWhatsApp: boolean;
}

export interface QueueSnapshot {
  date: string;
  session: { id: string; label: string; startTime: string; endTime: string } | null;
  inConsult: EntryView | null;
  next: EntryView | null;
  waiting: EntryView[];
  counts: { booked: number; walkins: number; completed: number; noShow: number; waiting: number };
  avgConsultMin: number;
  delayMin: number;
  pauseUntil: string | null;
  demo?: boolean;
}

function nameOf(e: EntryRow): string {
  if (e.profile) return decrypt(e.profile.name);
  if (e.displayName) return decrypt(e.displayName);
  return "Patient";
}

function displayShort(full: string): string {
  const parts = full.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts.at(-1)![0]}.` : parts[0]!;
}

function toQ(ctx: Ctx, e: QueueEntry): Q.QEntry {
  return {
    id: e.id, token: e.token, tokenNum: Number(e.token.replace(/\D/g, "")) || 0, source: e.source, state: e.state,
    arrivedMin: T.localMinutes(e.arrivedAt, ctx.tz),
    slotStartMin: e.slotStart ? T.localMinutes(e.slotStart, ctx.tz) : null,
    expectedMin: e.expectedAt ? T.localMinutes(e.expectedAt, ctx.tz) : null,
    lateArrival: e.lateArrival, manualRank: e.manualRank,
  };
}

/** The session instance the board shows: the running one, else the next one today. */
export async function boardSession(ctx: Ctx, info: ClinicInfo): Promise<{ session: Session; date: string } | null> {
  const cur = currentSession(ctx, info);
  if (cur) return cur;
  const n = nowLocal(ctx);
  const today = info.sessions.filter((s) => s.weekday === T.weekdayOf(n.date)).sort((a, b) => T.toMin(a.startTime) - T.toMin(b.startTime));
  const upcoming = today.find((s) => T.toMin(s.startTime) > n.min) ?? today.at(-1);
  return upcoming ? { session: upcoming, date: n.date } : null;
}

async function entries(ctx: Ctx, doctorId: string, date: string, sessionId: string): Promise<EntryRow[]> {
  return ctx.db.queueEntry.findMany({
    where: { doctorId, date: T.dateToDb(date), sessionId },
    include: { profile: { select: { name: true, accountId: true } } },
    orderBy: { arrivedAt: "asc" },
  });
}

function recentSources(rows: QueueEntry[]): ("A" | "W")[] {
  return rows.filter((r) => r.promotedAt).sort((a, b) => a.promotedAt!.getTime() - b.promotedAt!.getTime()).map((r) => r.source);
}

function delayFor(ctx: Ctx, info: ClinicInfo): number {
  const today = nowLocal(ctx).date;
  return info.doctor.delayDate && T.dateFromDb(info.doctor.delayDate) === today ? info.doctor.delayMinutes : 0;
}

async function freshDoctor(ctx: Ctx, info: ClinicInfo): Promise<ClinicInfo> {
  const doctor = await ctx.db.doctor.findUnique({ where: { id: info.doctor.id } });
  if (doctor) return { ...info, doctor };
  invalidateClinicCache();
  return clinicInfo(ctx);
}

export async function snapshot(ctx: Ctx, opts: { sessionId?: string; date?: string } = {}): Promise<QueueSnapshot> {
  let info = await clinicInfo(ctx);
  info = await freshDoctor(ctx, info);
  const n = nowLocal(ctx);
  const board = opts.sessionId ? { session: info.sessions.find((s) => s.id === opts.sessionId)!, date: opts.date ?? n.date } : await boardSession(ctx, info);
  const empty: QueueSnapshot = { date: n.date, session: null, inConsult: null, next: null, waiting: [], counts: { booked: 0, walkins: 0, completed: 0, noShow: 0, waiting: 0 }, avgConsultMin: 0, delayMin: 0, pauseUntil: null };
  if (!board?.session) return empty;
  const { session, date } = board;
  const rows = await entries(ctx, info.doctor.id, date, session.id);
  const durations = rows.filter((r) => r.state === "COMPLETED" && r.consultStartedAt && r.completedAt)
    .sort((a, b) => a.completedAt!.getTime() - b.completedAt!.getTime())
    .map((r) => (r.completedAt!.getTime() - r.consultStartedAt!.getTime()) / 60_000);
  const avg = Q.avgConsult(durations, session.slotMinutes);
  const now = ctx.clock.now();
  const inConsult = rows.find((r) => r.state === "IN_CONSULT") ?? null;
  const next = rows.find((r) => r.state === "NEXT") ?? null;
  const ordered = Q.positions(rows.filter((r) => r.state === "WAITING").map((r) => toQ(ctx, r)), n.min, recentSources(rows), { maxConsecutiveWalkins: info.settings.maxConsecutiveWalkins, dueLeadMinutes: 5 });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pauseRemaining = info.doctor.pauseUntil && info.doctor.pauseUntil > now ? (info.doctor.pauseUntil.getTime() - now.getTime()) / 60_000 : 0;
  const etaIn: Q.EtaInput = { avgConsultMin: avg, inConsultElapsedMin: inConsult?.consultStartedAt ? (now.getTime() - inConsult.consultStartedAt.getTime()) / 60_000 : null, hasNext: !!next, delayMin: delayFor(ctx, info), pauseRemainingMin: pauseRemaining };
  const view = (r: EntryRow, k: number | null): EntryView => {
    const full = nameOf(r);
    return {
      id: r.id, token: r.token, source: r.source, state: r.state, name: displayShort(full), firstName: firstName(full),
      arrivedAt: r.arrivedAt.toISOString(), slotStart: r.slotStart?.toISOString() ?? null, expectedAt: r.expectedAt?.toISOString() ?? null,
      lateArrival: r.lateArrival, etaMin: k == null ? null : Math.round(Q.etaMinutes(k, etaIn)), ahead: k == null ? null : (next ? 1 : 0) + k,
      version: r.version, hasWhatsApp: !!r.profile?.accountId,
    };
  };
  const booked = await ctx.db.appointment.count({ where: { doctorId: info.doctor.id, sessionId: session.id, slotStart: { gte: T.toInstant(date, "00:00", ctx.tz), lt: T.toInstant(T.addDays(date, 1), "00:00", ctx.tz) }, status: { in: ["BOOKED", "ARRIVED", "COMPLETED", "NO_SHOW"] } } });
  return {
    date,
    session: { id: session.id, label: session.label, startTime: session.startTime, endTime: session.endTime },
    inConsult: inConsult ? view(inConsult, null) : null,
    next: next ? view(next, null) : null,
    waiting: ordered.map((q, k) => view(byId.get(q.id)!, k)),
    counts: {
      booked,
      walkins: rows.filter((r) => r.source === "W").length,
      completed: rows.filter((r) => r.state === "COMPLETED").length,
      noShow: rows.filter((r) => r.state === "NO_SHOW").length,
      waiting: ordered.length,
    },
    avgConsultMin: avg,
    demo: info.clinic.isDemo,
    delayMin: delayFor(ctx, info),
    pauseUntil: info.doctor.pauseUntil && info.doctor.pauseUntil > now ? info.doctor.pauseUntil.toISOString() : null,
  };
}

/** Patient's own queue position (for STATUS replies). */
export async function positionOf(ctx: Ctx, entryId: string): Promise<{ entry: EntryView; snap: QueueSnapshot } | null> {
  const e = await ctx.db.queueEntry.findUnique({ where: { id: entryId } });
  if (!e) return null;
  const snap = await snapshot(ctx, { sessionId: e.sessionId, date: T.dateFromDb(e.date) });
  const all = [snap.inConsult, snap.next, ...snap.waiting].filter(Boolean) as EntryView[];
  const v = all.find((x) => x.id === entryId);
  return v ? { entry: v, snap } : null;
}

// ── mutations ───────────────────────────────────────────────

export async function arriveAppointment(ctx: Ctx, apptId: string, actor: { type: string; id: string | null }): Promise<QueueEntry> {
  return withQueueLock(LOCK, () => arriveAppointmentUnlocked(ctx, apptId, actor));
}

async function arriveAppointmentUnlocked(ctx: Ctx, apptId: string, actor: { type: string; id: string | null }): Promise<QueueEntry> {
  const info = await clinicInfo(ctx);
  const a = await ctx.db.appointment.findUniqueOrThrow({ where: { id: apptId } });
  const existing = await ctx.db.queueEntry.findUnique({ where: { appointmentId: apptId } });
  if (existing && ["WAITING", "NEXT", "IN_CONSULT"].includes(existing.state)) return existing;
  const now = ctx.clock.now();
  const late = now.getTime() > a.slotStart.getTime() + info.settings.lateGraceMinutes * 60_000;
  const date = T.localDate(a.slotStart, ctx.tz);
  let entry: QueueEntry;
  if (existing) {
    entry = await ctx.db.queueEntry.update({ where: { id: existing.id }, data: { state: "WAITING", arrivedAt: now, lateArrival: true, manualRank: null, version: { increment: 1 } } });
  } else {
    entry = await ctx.db.queueEntry.create({
      data: { doctorId: a.doctorId, sessionId: a.sessionId, date: T.dateToDb(date), profileId: a.profileId, appointmentId: a.id, source: "A", token: a.token ?? "A-?", state: "WAITING", arrivedAt: now, slotStart: a.slotStart, lateArrival: late },
    });
  }
  await ctx.db.appointment.update({ where: { id: a.id }, data: { status: "ARRIVED", arrivedAt: now } });
  await ctx.jobs.cancel(`early:${a.id}`);
  await audit(ctx, actor.type, actor.id, "queue.arrive", "QueueEntry", entry.id, { token: entry.token, late });
  await afterChange(ctx, entry.doctorId, { joined: entry.id });
  return entry;
}

export async function issueWalkin(ctx: Ctx, opts: { sessionId: string; date: string; profileId?: string | null; displayName?: string | null; expectedAt?: Date | null; actor: { type: string; id: string | null } }): Promise<QueueEntry> {
  return withQueueLock(LOCK, () => issueWalkinUnlocked(ctx, opts));
}

async function issueWalkinUnlocked(ctx: Ctx, opts: { sessionId: string; date: string; profileId?: string | null; displayName?: string | null; expectedAt?: Date | null; actor: { type: string; id: string | null } }): Promise<QueueEntry> {
  const info = await clinicInfo(ctx);
  const ts = info.settings.tokenSeries;
  const now = ctx.clock.now();
  const entry = await ctx.db.$transaction(async (tx) => {
    const n = await allocateToken(tx, info.doctor.id, opts.date, opts.sessionId, ts.singleSeries ? "N" : "W");
    return tx.queueEntry.create({
      data: {
        doctorId: info.doctor.id, sessionId: opts.sessionId, date: T.dateToDb(opts.date), profileId: opts.profileId ?? null,
        displayName: opts.displayName ? encrypt(opts.displayName) : null, source: "W", token: ts.singleSeries ? String(n) : `${ts.walkinPrefix}-${n}`,
        state: "WAITING", arrivedAt: now, expectedAt: opts.expectedAt ?? null,
      },
    });
  });
  await audit(ctx, opts.actor.type, opts.actor.id, "queue.walkin", "QueueEntry", entry.id, { token: entry.token });
  await afterChange(ctx, info.doctor.id, { joined: entry.id });
  return entry;
}

export async function walkinsIssued(ctx: Ctx, sessionId: string, date: string): Promise<number> {
  return ctx.db.queueEntry.count({ where: { sessionId, date: T.dateToDb(date), source: "W" } });
}

async function guard(ctx: Ctx, id: string, version?: number): Promise<QueueEntry> {
  const e = await ctx.db.queueEntry.findUniqueOrThrow({ where: { id } });
  if (version != null && e.version !== version) throw new StaleError();
  return e;
}

/** "Consultation completed" — complete → start next → promote top waiting (one tap). */
export async function advance(ctx: Ctx, actor: { type: string; id: string | null }, expectInConsult?: string | null): Promise<QueueSnapshot> {
  return withQueueLock(LOCK, () => advanceUnlocked(ctx, actor, expectInConsult));
}

async function advanceUnlocked(ctx: Ctx, actor: { type: string; id: string | null }, expectInConsult?: string | null): Promise<QueueSnapshot> {
  const info = await clinicInfo(ctx);
  const board = await boardSession(ctx, info);
  if (!board) return snapshot(ctx);
  const rows = await entries(ctx, info.doctor.id, board.date, board.session.id);
  const cur = rows.find((r) => r.state === "IN_CONSULT");
  // The board says which patient it is completing; a stale double-tap is rejected, not applied.
  if (expectInConsult !== undefined && (cur?.id ?? null) !== expectInConsult) throw new StaleError();
  // Cabin empty → "next" means: send the next patient in (and line up the one after).
  if (!cur) return startNextUnlocked(ctx, actor);
  const n = nowLocal(ctx);
  const plan = Q.planAdvance(rows.map((r) => toQ(ctx, r)), n.min, recentSources(rows), { maxConsecutiveWalkins: info.settings.maxConsecutiveWalkins, dueLeadMinutes: 5 });
  const now = ctx.clock.now();
  const events: Events = {};
  await ctx.db.$transaction(async (tx) => {
    if (plan.complete) {
      await tx.queueEntry.update({ where: { id: plan.complete }, data: { state: "COMPLETED", completedAt: now, version: { increment: 1 } } });
      const c = rows.find((r) => r.id === plan.complete);
      if (c?.appointmentId) await tx.appointment.update({ where: { id: c.appointmentId }, data: { status: "COMPLETED", slotKey: null } });
    }
    if (plan.start) { await tx.queueEntry.update({ where: { id: plan.start }, data: { state: "IN_CONSULT", consultStartedAt: now, version: { increment: 1 } } }); events.started = plan.start; }
    if (plan.promote) { await tx.queueEntry.update({ where: { id: plan.promote }, data: { state: "NEXT", promotedAt: now, manualRank: null, version: { increment: 1 } } }); events.promoted = plan.promote; }
  });
  if (plan.complete) await ctx.jobs.cancel(`noshow:${rows.find((r) => r.id === plan.complete)?.appointmentId}`);
  await audit(ctx, actor.type, actor.id, "queue.advance", "QueueEntry", plan.complete ?? plan.start ?? null, plan as Record<string, unknown>);
  await afterChange(ctx, info.doctor.id, events);
  return snapshot(ctx);
}

export async function startNext(ctx: Ctx, actor: { type: string; id: string | null }): Promise<QueueSnapshot> {
  return withQueueLock(LOCK, () => startNextUnlocked(ctx, actor));
}

async function startNextUnlocked(ctx: Ctx, actor: { type: string; id: string | null }): Promise<QueueSnapshot> {
  const info = await clinicInfo(ctx);
  const board = await boardSession(ctx, info);
  if (!board) return snapshot(ctx);
  const rows = await entries(ctx, info.doctor.id, board.date, board.session.id);
  if (rows.some((r) => r.state === "IN_CONSULT")) return advanceUnlocked(ctx, actor);
  let next = rows.find((r) => r.state === "NEXT");
  if (!next) {
    const p = Q.pickNext(rows.map((r) => toQ(ctx, r)), nowLocal(ctx).min, recentSources(rows));
    if (!p) return snapshot(ctx);
    next = rows.find((r) => r.id === p.id)!;
    await ctx.db.queueEntry.update({ where: { id: next.id }, data: { state: "NEXT", promotedAt: ctx.clock.now(), manualRank: null, version: { increment: 1 } } });
  }
  await ctx.db.queueEntry.update({ where: { id: next.id }, data: { state: "IN_CONSULT", consultStartedAt: ctx.clock.now(), version: { increment: 1 } } });
  await audit(ctx, actor.type, actor.id, "queue.start", "QueueEntry", next.id);
  const events: Events = { started: next.id };
  // promote the following patient so "Next" is always filled
  const after = await entries(ctx, info.doctor.id, board.date, board.session.id);
  const p2 = Q.pickNext(after.map((r) => toQ(ctx, r)), nowLocal(ctx).min, recentSources(after));
  if (p2) { await ctx.db.queueEntry.update({ where: { id: p2.id }, data: { state: "NEXT", promotedAt: ctx.clock.now(), version: { increment: 1 } } }); events.promoted = p2.id; }
  await afterChange(ctx, info.doctor.id, events);
  return snapshot(ctx);
}

export async function markNoShow(ctx: Ctx, id: string, actor: { type: string; id: string | null }, version?: number): Promise<QueueSnapshot> {
  return withQueueLock(LOCK, () => markNoShowUnlocked(ctx, id, actor, version));
}

async function markNoShowUnlocked(ctx: Ctx, id: string, actor: { type: string; id: string | null }, version?: number): Promise<QueueSnapshot> {
  const e = await guard(ctx, id, version);
  if (!Q.canTransition(e.state, "NO_SHOW")) throw new StaleError();
  await ctx.db.queueEntry.update({ where: { id }, data: { state: "NO_SHOW", version: { increment: 1 } } });
  await audit(ctx, actor.type, actor.id, "queue.no_show", "QueueEntry", id);
  const events: Events = { noShow: id };
  if (e.state === "NEXT") {
    const info = await clinicInfo(ctx);
    const rows = await entries(ctx, e.doctorId, T.dateFromDb(e.date), e.sessionId);
    const p = Q.pickNext(rows.map((r) => toQ(ctx, r)), nowLocal(ctx).min, recentSources(rows), { maxConsecutiveWalkins: info.settings.maxConsecutiveWalkins, dueLeadMinutes: 5 });
    if (p) { await ctx.db.queueEntry.update({ where: { id: p.id }, data: { state: "NEXT", promotedAt: ctx.clock.now(), version: { increment: 1 } } }); events.promoted = p.id; }
  }
  await afterChange(ctx, e.doctorId, events);
  return snapshot(ctx);
}

export async function cancelEntry(ctx: Ctx, id: string, actor: { type: string; id: string | null }, version?: number): Promise<QueueSnapshot> {
  return withQueueLock(LOCK, () => cancelEntryUnlocked(ctx, id, actor, version));
}

async function cancelEntryUnlocked(ctx: Ctx, id: string, actor: { type: string; id: string | null }, version?: number): Promise<QueueSnapshot> {
  const e = await guard(ctx, id, version);
  if (!Q.canTransition(e.state, "CANCELLED")) throw new StaleError();
  await ctx.db.queueEntry.update({ where: { id }, data: { state: "CANCELLED", version: { increment: 1 } } });
  if (e.appointmentId) await ctx.db.appointment.update({ where: { id: e.appointmentId }, data: { status: "CANCELLED", slotKey: null, cancelledBy: "CLINIC", cancelledAt: ctx.clock.now() } });
  await audit(ctx, actor.type, actor.id, "queue.cancel", "QueueEntry", id);
  await afterChange(ctx, e.doctorId, {});
  return snapshot(ctx);
}

export async function readd(ctx: Ctx, id: string, actor: { type: string; id: string | null }): Promise<QueueSnapshot> {
  return withQueueLock(LOCK, () => readdUnlocked(ctx, id, actor));
}

async function readdUnlocked(ctx: Ctx, id: string, actor: { type: string; id: string | null }): Promise<QueueSnapshot> {
  const e = await guard(ctx, id);
  if (e.state !== "NO_SHOW") throw new StaleError();
  await ctx.db.queueEntry.update({ where: { id }, data: { state: "WAITING", arrivedAt: ctx.clock.now(), lateArrival: true, manualRank: null, turnNearSentAt: null, version: { increment: 1 } } });
  await audit(ctx, actor.type, actor.id, "queue.readd", "QueueEntry", id);
  await afterChange(ctx, e.doctorId, {});
  return snapshot(ctx);
}

export async function undoStart(ctx: Ctx, id: string, actor: { type: string; id: string | null }): Promise<QueueSnapshot> {
  return withQueueLock(LOCK, () => undoStartUnlocked(ctx, id, actor));
}

async function undoStartUnlocked(ctx: Ctx, id: string, actor: { type: string; id: string | null }): Promise<QueueSnapshot> {
  const e = await guard(ctx, id);
  if (e.state !== "IN_CONSULT" || !e.consultStartedAt || ctx.clock.now().getTime() - e.consultStartedAt.getTime() > 2 * 60_000) throw new StaleError();
  const info = await clinicInfo(ctx);
  const rows = await entries(ctx, e.doctorId, T.dateFromDb(e.date), e.sessionId);
  await ctx.db.$transaction(async (tx) => {
    const curNext = rows.find((r) => r.state === "NEXT");
    if (curNext) await tx.queueEntry.update({ where: { id: curNext.id }, data: { state: "WAITING", manualRank: -1, version: { increment: 1 } } });
    await tx.queueEntry.update({ where: { id }, data: { state: "NEXT", consultStartedAt: null, version: { increment: 1 } } });
  });
  void info;
  await audit(ctx, actor.type, actor.id, "queue.undo", "QueueEntry", id);
  await afterChange(ctx, e.doctorId, {});
  return snapshot(ctx);
}

/** Move up/down/top within Waiting: freezes the current order as manual ranks, then swaps. */
export async function move(ctx: Ctx, id: string, dir: "up" | "down" | "top", actor: { type: string; id: string | null }): Promise<QueueSnapshot> {
  return withQueueLock(LOCK, () => moveUnlocked(ctx, id, dir, actor));
}

async function moveUnlocked(ctx: Ctx, id: string, dir: "up" | "down" | "top", actor: { type: string; id: string | null }): Promise<QueueSnapshot> {
  const snap = await snapshot(ctx);
  const order = snap.waiting.map((w) => w.id);
  const i = order.indexOf(id);
  if (i < 0) throw new StaleError();
  order.splice(i, 1);
  const j = dir === "top" ? 0 : dir === "up" ? Math.max(0, i - 1) : Math.min(order.length, i + 1);
  order.splice(j, 0, id);
  await ctx.db.$transaction(order.map((eid, k) => ctx.db.queueEntry.update({ where: { id: eid }, data: { manualRank: k, version: { increment: 1 } } })));
  await audit(ctx, actor.type, actor.id, "queue.move", "QueueEntry", id, { dir });
  const info = await clinicInfo(ctx);
  await afterChange(ctx, info.doctor.id, {});
  return snapshot(ctx);
}

export async function setDelay(ctx: Ctx, minutes: number, actor: { type: string; id: string | null }): Promise<number> {
  const info = await clinicInfo(ctx);
  await ctx.db.doctor.update({ where: { id: info.doctor.id }, data: { delayMinutes: minutes, delayDate: T.dateToDb(nowLocal(ctx).date) } });
  await audit(ctx, actor.type, actor.id, "doctor.late", "Doctor", info.doctor.id, { minutes });
  ctx.bus.publish({ type: "doctor.status", delayMin: minutes, pauseUntil: null });
  // Broadcast to everyone waiting or still booked today.
  const snap = await snapshot(ctx);
  let informed = 0;
  const targets = [snap.next, ...snap.waiting].filter(Boolean) as EntryView[];
  for (const w of targets) {
    const e = await ctx.db.queueEntry.findUnique({ where: { id: w.id }, include: { profile: true } });
    const accId = e?.profile?.accountId;
    if (!accId) continue;
    const acc = await ctx.db.patientAccount.findUniqueOrThrow({ where: { id: accId } });
    const newTime = T.fmtTime(nowLocal(ctx).min + (w.etaMin ?? 0));
    const ok = await sendToAccount(ctx, accId, { kind: "text", body: C.render("DOCTOR_LATE", acc.language, { min: minutes, newTime }) }, { kind: "DOCTOR_LATE", essential: false, template: { name: "doctor_running_late", lang: acc.language, vars: { name: w.firstName, min: minutes, newTime } } });
    if (ok) informed++;
  }
  // Booked but not yet arrived, later today.
  const n = nowLocal(ctx);
  const booked = await ctx.db.appointment.findMany({ where: { doctorId: info.doctor.id, status: "BOOKED", slotStart: { gte: ctx.clock.now(), lt: T.toInstant(T.addDays(n.date, 1), "00:00", ctx.tz) } }, include: { profile: true } });
  for (const a of booked) {
    const accId = a.profile?.accountId;
    if (!accId) continue;
    const acc = await ctx.db.patientAccount.findUniqueOrThrow({ where: { id: accId } });
    const newTime = T.fmtTime(T.localMinutes(a.slotStart, ctx.tz) + minutes);
    const ok = await sendToAccount(ctx, accId, { kind: "text", body: C.render("DOCTOR_LATE", acc.language, { min: minutes, newTime }) }, { kind: "DOCTOR_LATE", essential: false, template: { name: "doctor_running_late", lang: acc.language, vars: { name: firstName(decrypt(a.profile!.name)), min: minutes, newTime } } });
    if (ok) informed++;
  }
  ctx.bus.publish({ type: "queue.updated", doctorId: info.doctor.id });
  return informed;
}

export async function setPause(ctx: Ctx, minutes: number, actor: { type: string; id: string | null }): Promise<number> {
  const info = await clinicInfo(ctx);
  const until = minutes > 0 ? new Date(ctx.clock.now().getTime() + minutes * 60_000) : null;
  await ctx.db.doctor.update({ where: { id: info.doctor.id }, data: { pauseUntil: until } });
  await audit(ctx, actor.type, actor.id, minutes > 0 ? "doctor.pause" : "doctor.resume", "Doctor", info.doctor.id, { minutes });
  ctx.bus.publish({ type: "doctor.status", delayMin: 0, pauseUntil: until?.toISOString() ?? null });
  let informed = 0;
  if (minutes > 0) {
    const snap = await snapshot(ctx);
    for (const w of snap.waiting) {
      const e = await ctx.db.queueEntry.findUnique({ where: { id: w.id }, include: { profile: true } });
      if (!e?.profile?.accountId) continue;
      const acc = await ctx.db.patientAccount.findUniqueOrThrow({ where: { id: e.profile.accountId } });
      if (await sendToAccount(ctx, acc.id, { kind: "text", body: C.render("DOCTOR_BREAK", acc.language, { min: minutes }) }, { kind: "DOCTOR_BREAK", essential: false })) informed++;
    }
  }
  ctx.bus.publish({ type: "queue.updated", doctorId: info.doctor.id });
  return informed;
}

// ── alerts ─────────────────────────────────────────────────

interface Events { promoted?: string; started?: string; noShow?: string; joined?: string }

async function notifyEntry(ctx: Ctx, entryId: string, copyId: "YOU_ARE_NEXT" | "YOUR_TURN" | "TURN_NEAR" | "NO_SHOW_CALLED", vars: C.Vars, template?: "your_turn" | "turn_near"): Promise<void> {
  const e = await ctx.db.queueEntry.findUnique({ where: { id: entryId }, include: { profile: true } });
  const accId = e?.profile?.accountId;
  if (!e || !accId) return;
  const acc = await ctx.db.patientAccount.findUniqueOrThrow({ where: { id: accId } });
  const name = firstName(decrypt(e.profile!.name));
  const v = { name, token: e.token, ...vars };
  await sendToAccount(ctx, accId, { kind: "text", body: C.render(copyId, acc.language, v) }, {
    kind: copyId, essential: copyId !== "TURN_NEAR",
    template: template ? { name: template, lang: acc.language, vars: v as Record<string, string | number> } : undefined,
  });
}

async function afterChange(ctx: Ctx, doctorId: string, ev: Events): Promise<void> {
  const info = await clinicInfo(ctx);
  // Auto-promote (QUEUE_ENGINE §4.2): whenever Next is empty and someone is waiting, line them up.
  const board = await boardSession(ctx, info);
  if (board && !ev.promoted) {
    const rows = await entries(ctx, info.doctor.id, board.date, board.session.id);
    if (!rows.some((r) => r.state === "NEXT") && rows.some((r) => r.state === "WAITING")) {
      const p = Q.pickNext(rows.map((r) => toQ(ctx, r)), nowLocal(ctx).min, recentSources(rows), { maxConsecutiveWalkins: info.settings.maxConsecutiveWalkins, dueLeadMinutes: 5 });
      if (p) {
        const claimed = await ctx.db.queueEntry.updateMany({ where: { id: p.id, state: "WAITING" }, data: { state: "NEXT", promotedAt: ctx.clock.now(), manualRank: null, version: { increment: 1 } } }).catch(() => ({ count: 0 }));
        if (claimed.count) ev = { ...ev, promoted: p.id };
      }
    }
  }
  if (ev.started) await notifyEntry(ctx, ev.started, "YOUR_TURN", {}, "your_turn");
  // A patient who just joined hears "you're next" from the joining flow, after their token message.
  if (ev.promoted && ev.promoted !== ev.started && ev.promoted !== ev.joined) await notifyEntry(ctx, ev.promoted, "YOU_ARE_NEXT", {});
  if (ev.noShow) await notifyEntry(ctx, ev.noShow, "NO_SHOW_CALLED", {});
  // Turn-near alerts.
  const snap = await snapshot(ctx);
  for (const w of snap.waiting) {
    if (w.ahead == null || w.ahead > info.settings.turnNearThreshold || w.ahead === 0) continue;
    // A patient who joins already near the front is told in the joining message itself.
    if (w.id === ev.joined) { await ctx.db.queueEntry.updateMany({ where: { id: w.id, turnNearSentAt: null }, data: { turnNearSentAt: ctx.clock.now() } }); continue; }
    const claimed = await ctx.db.queueEntry.updateMany({ where: { id: w.id, turnNearSentAt: null }, data: { turnNearSentAt: ctx.clock.now() } });
    if (claimed.count) await notifyEntry(ctx, w.id, "TURN_NEAR", { ahead: w.ahead, eta: Q.roundEta(w.etaMin ?? 5) }, "turn_near");
  }
  ctx.bus.publish({ type: "queue.updated", doctorId });
}

export { afterChange as refreshQueue };

/** After a joining message: if the patient is already Next, tell them now (keeps message order right). */
export async function notifyIfNext(ctx: Ctx, entryId: string): Promise<void> {
  const e = await ctx.db.queueEntry.findUnique({ where: { id: entryId } });
  if (e?.state === "NEXT") await notifyEntry(ctx, entryId, "YOU_ARE_NEXT", {});
}
