import { randomInt } from "node:crypto";
import { decrypt, maskPhone, type WalkinOverflowRequest } from "@clinicq/db";
import { copy as C, time as T } from "@clinicq/core";
import type { Ctx } from "../context";
import { clinicInfo, currentSession, nowLocal } from "./clinic";
import { audit, sendTo, sendToAccount } from "./notify";
import { issueWalkin, notifyIfNext, positionOf, walkinsIssued } from "./queue";
import { firstName } from "./patients";

// Walk-ins (docs/PRD.md WI-01…WI-05): rotating daily QR code, quota, staff escalation when full.

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export async function dailyCode(ctx: Ctx, date?: string): Promise<string> {
  const info = await clinicInfo(ctx);
  const d = date ?? nowLocal(ctx).date;
  const existing = await ctx.db.dailyWalkinCode.findUnique({ where: { clinicId_date: { clinicId: info.clinic.id, date: T.dateToDb(d) } } });
  if (existing) return existing.code;
  const code = Array.from({ length: 4 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");
  await ctx.db.dailyWalkinCode.upsert({ where: { clinicId_date: { clinicId: info.clinic.id, date: T.dateToDb(d) } }, create: { clinicId: info.clinic.id, date: T.dateToDb(d), code }, update: {} });
  return (await ctx.db.dailyWalkinCode.findUniqueOrThrow({ where: { clinicId_date: { clinicId: info.clinic.id, date: T.dateToDb(d) } } })).code;
}

export const WALKIN_RE = /^\s*WALKIN\s+([A-Z0-9]+)-([A-Z0-9]+)\s*$/i;

export async function walkinLink(ctx: Ctx, waNumber: string): Promise<{ text: string; url: string }> {
  const info = await clinicInfo(ctx);
  const text = `WALKIN ${info.clinic.code}-${await dailyCode(ctx)}`;
  return { text, url: `https://wa.me/${waNumber.replace(/\D/g, "")}?text=${encodeURIComponent(text)}` };
}

export async function validateWalkinCode(ctx: Ctx, text: string): Promise<boolean> {
  const m = text.match(WALKIN_RE);
  if (!m) return false;
  const info = await clinicInfo(ctx);
  return m[1]!.toUpperCase() === info.clinic.code.toUpperCase() && m[2]!.toUpperCase() === (await dailyCode(ctx)).toUpperCase();
}

export type WalkinResult =
  | { kind: "issued"; token: string; ahead: number; eta: number; entryId: string }
  | { kind: "overflow"; requestId: string }
  | { kind: "closed"; next: string | null };

/** Join today's queue: issue directly while quota remains, else escalate to on-duty staff. */
export async function requestWalkin(ctx: Ctx, accountId: string, profileId: string): Promise<WalkinResult> {
  const info = await clinicInfo(ctx);
  const cur = currentSession(ctx, info);
  const n = nowLocal(ctx);
  const closure = cur ? await ctx.db.closure.findFirst({ where: { doctorId: info.doctor.id, date: T.dateToDb(n.date), OR: [{ sessionId: null }, { sessionId: cur.session.id }] } }) : null;
  if (!cur || closure) {
    const nextS = info.sessions.map((s) => ({ s, d: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => T.addDays(n.date, i)).find((d) => T.weekdayOf(d) === s.weekday && (d !== n.date || T.toMin(s.startTime) > n.min)) }))
      .filter((x) => x.d).sort((a, b) => (a.d! + a.s.startTime).localeCompare(b.d! + b.s.startTime))[0];
    return { kind: "closed", next: nextS ? `${T.fmtDayLabel(nextS.d!, n.date)} ${T.fmtTime(nextS.s.startTime)}` : null };
  }
  const already = await ctx.db.queueEntry.findFirst({ where: { doctorId: info.doctor.id, profileId, date: T.dateToDb(cur.date), state: { in: ["WAITING", "NEXT", "IN_CONSULT"] } } });
  if (already) {
    const p = await positionOf(ctx, already.id);
    return { kind: "issued", token: already.token, ahead: p?.entry.ahead ?? 0, eta: p?.entry.etaMin ?? 5, entryId: already.id };
  }
  const issued = await walkinsIssued(ctx, cur.session.id, cur.date);
  if (issued < cur.session.walkinQuota) {
    const e = await issueWalkin(ctx, { sessionId: cur.session.id, date: cur.date, profileId, actor: { type: "PATIENT", id: accountId } });
    const p = await positionOf(ctx, e.id);
    return { kind: "issued", token: e.token, ahead: p?.entry.ahead ?? 0, eta: p?.entry.etaMin ?? 5, entryId: e.id };
  }
  const pending = await ctx.db.walkinOverflowRequest.findFirst({ where: { doctorId: info.doctor.id, profileId, status: "PENDING" } });
  if (pending) return { kind: "overflow", requestId: pending.id };
  const expiresAt = new Date(ctx.clock.now().getTime() + info.settings.walkinOverflowTimeoutMinutes * 60_000);
  const req = await ctx.db.walkinOverflowRequest.create({ data: { doctorId: info.doctor.id, sessionId: cur.session.id, date: T.dateToDb(cur.date), profileId, accountId, expiresAt } });
  await ctx.jobs.schedule("overflowTimeout", { requestId: req.id }, expiresAt, `ovf:${req.id}`);
  await notifyStaffOverflow(ctx, req, cur.session.label);
  return { kind: "overflow", requestId: req.id };
}

async function notifyStaffOverflow(ctx: Ctx, req: WalkinOverflowRequest, sessionLabel: string): Promise<void> {
  const info = await clinicInfo(ctx);
  const profile = await ctx.db.patientProfile.findUniqueOrThrow({ where: { id: req.profileId }, include: { account: true } });
  const name = decrypt(profile.name);
  const masked = profile.account ? maskPhone(decrypt(profile.account.waPhone)) : "";
  ctx.bus.publish({ type: "overflow.requested", id: req.id, name, sessionLabel, expiresAt: req.expiresAt.toISOString() });
  const staff = await ctx.db.staffUser.findMany({ where: { clinicId: info.clinic.id, active: true, onDuty: true } });
  for (const s of staff) {
    await sendTo(ctx, decrypt(s.waPhone), {
      kind: "buttons",
      body: `Walk-in quota full for the ${sessionLabel} session.\n${name} (${masked}) is at reception.\nCan you adjust?`,
      buttons: [{ id: `ovf:${req.id}:yes`, title: C.btn("YES_ADJUST", "en") }, { id: `ovf:${req.id}:no`, title: C.btn("NO", "en") }],
    }, { kind: "staff_walkin_overflow" });
  }
}

export type OverflowDecision = { decision: "yes"; time?: Date | null; endOfQueue?: boolean } | { decision: "no" };

/** First staff decision wins. Returns false if already handled. */
export async function decideOverflow(ctx: Ctx, requestId: string, d: OverflowDecision, staff: { id: string | null; name: string }): Promise<{ ok: boolean; handledBy?: string; status?: string }> {
  const req = await ctx.db.walkinOverflowRequest.findUnique({ where: { id: requestId } });
  if (!req) return { ok: false };
  if (req.status !== "PENDING") return { ok: false, status: req.status, handledBy: req.decidedById ?? undefined };
  const now = ctx.clock.now();
  const claim = await ctx.db.walkinOverflowRequest.updateMany({
    where: { id: requestId, status: "PENDING" },
    data: { status: d.decision === "yes" ? "APPROVED" : "DECLINED", decidedById: staff.id, decidedAt: now, assignedTime: d.decision === "yes" ? d.time ?? null : null, endOfQueue: d.decision === "yes" ? !!d.endOfQueue : false },
  });
  if (!claim.count) return { ok: false };
  await ctx.jobs.cancel(`ovf:${requestId}`);
  await audit(ctx, "STAFF", staff.id, `walkin.overflow.${d.decision}`, "WalkinOverflowRequest", requestId);
  ctx.bus.publish({ type: "overflow.resolved", id: requestId, status: d.decision === "yes" ? "APPROVED" : "DECLINED", by: staff.name });
  if (d.decision === "yes") await approved(ctx, req, d.time ?? null, staff.id);
  else await declined(ctx, req, "WALKIN_DECLINED");
  return { ok: true };
}

async function approved(ctx: Ctx, req: WalkinOverflowRequest, time: Date | null, staffId: string | null): Promise<void> {
  const e = await issueWalkin(ctx, { sessionId: req.sessionId, date: T.dateFromDb(req.date), profileId: req.profileId, expectedAt: time, actor: { type: "STAFF", id: staffId } });
  const p = await positionOf(ctx, e.id);
  if (!req.accountId) return;
  const acc = await ctx.db.patientAccount.findUniqueOrThrow({ where: { id: req.accountId } });
  const prof = await ctx.db.patientProfile.findUniqueOrThrow({ where: { id: req.profileId } });
  const name = firstName(decrypt(prof.name));
  const at = time ?? new Date(ctx.clock.now().getTime() + (p?.entry.etaMin ?? 0) * 60_000);
  await sendToAccount(ctx, acc.id, {
    kind: "buttons",
    body: C.render("WALKIN_ADJUSTED", acc.language, { name, token: e.token, time: T.fmtTime(T.localMinutes(at, ctx.tz)), ahead: p?.entry.ahead ?? 0 }),
    buttons: [{ id: "menu:status", title: C.btn("CHECK_STATUS", acc.language) }],
  }, { kind: "WALKIN_ADJUSTED", template: { name: "walkin_token", lang: acc.language, vars: { token: e.token, name, clinicName: (await clinicInfo(ctx)).clinic.name, ahead: p?.entry.ahead ?? 0, eta: p?.entry.etaMin ?? 5 } } });
  await ctx.db.conversationState.deleteMany({ where: { accountId: acc.id } });
  await notifyIfNext(ctx, e.id);
}

/** Staff said no, or nobody answered: offer booking slots instead (handled by the conversation engine hook). */
export let onOverflowDeclined: (ctx: Ctx, req: WalkinOverflowRequest, copyId: "WALKIN_DECLINED" | "WALKIN_TIMEOUT") => Promise<void> = async () => {};
export function setOverflowDeclinedHandler(h: typeof onOverflowDeclined): void { onOverflowDeclined = h; }

async function declined(ctx: Ctx, req: WalkinOverflowRequest, copyId: "WALKIN_DECLINED" | "WALKIN_TIMEOUT"): Promise<void> {
  await onOverflowDeclined(ctx, req, copyId);
}

export async function overflowTimeout(ctx: Ctx, requestId: string): Promise<void> {
  const claim = await ctx.db.walkinOverflowRequest.updateMany({ where: { id: requestId, status: "PENDING" }, data: { status: "TIMED_OUT", decidedAt: ctx.clock.now() } });
  if (!claim.count) return;
  const req = await ctx.db.walkinOverflowRequest.findUniqueOrThrow({ where: { id: requestId } });
  ctx.bus.publish({ type: "overflow.resolved", id: requestId, status: "TIMED_OUT" });
  await audit(ctx, "SYSTEM", null, "walkin.overflow.timeout", "WalkinOverflowRequest", requestId);
  await declined(ctx, req, "WALKIN_TIMEOUT");
}
