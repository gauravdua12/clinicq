import type { FastifyInstance, FastifyReply } from "fastify";
import QRCode from "qrcode";
import { z } from "zod";
import { decrypt, displayPhone, encrypt, maskPhone, normalizeIndianPhone, phoneHash } from "@clinicq/db";
import { copy as C, slots as S, time as T } from "@clinicq/core";
import type { Ctx } from "../context";
import { cancelAppointment, confirmHold, holdSlot, reschedule, SlotTakenError, FamilySlotError } from "../services/booking";
import { availability, clinicInfo, invalidateClinicCache, nowLocal, windowAvailability } from "../services/clinic";
import { affectedByClosure, applyClosure } from "../services/closures";
import { audit, sendToAccount } from "../services/notify";
import { createProfile, findOrCreateAccount, firstName } from "../services/patients";
import * as Q from "../services/queue";
import { decideOverflow, walkinLink } from "../services/walkin";
import { ClinicSettings } from "../settings";
import { activateDemo, createDemo, deleteDemo, extractProfile, resetDemo, type ClinicProfile } from "../services/demo";
import type { AiRuntime } from "../services/ai";
import { requireIncoloAdmin, requireStaff } from "./auth";

// REST API for the dashboard and TV (docs/API.md). Phone numbers never appear in list views.

function sendErr(reply: FastifyReply, code: number, c: string) { return reply.code(code).send({ error: { code: c } }); }

async function wrapQueue(reply: FastifyReply, fn: () => Promise<unknown>) {
  try { return await fn(); } catch (e) {
    if (e instanceof Q.StaleError) return sendErr(reply, 409, "STALE");
    throw e;
  }
}

export async function apiRoutes(app: FastifyInstance, ctx: Ctx, ai: AiRuntime): Promise<void> {
  const actorOf = (s: { id: string; role: string }) => ({ type: s.role, id: s.id });

  app.get("/api/clinic", async (req, reply) => {
    if (!(await requireStaff(ctx, req, reply))) return;
    const info = await clinicInfo(ctx);
    return { name: info.clinic.name, isDemo: info.clinic.isDemo, doctor: info.doctor.displayName, demoStudio: ctx.env.DEMO_STUDIO, today: nowLocal(ctx).date };
  });

  // ── queue ──
  app.get("/api/queue/today", async (req, reply) => { if (!(await requireStaff(ctx, req, reply))) return; return Q.snapshot(ctx); });
  app.post("/api/queue/advance", async (req, reply) => {
    const s = await requireStaff(ctx, req, reply); if (!s) return;
    const expect = (req.body as { expectInConsult?: string | null } | undefined)?.expectInConsult;
    return wrapQueue(reply, () => Q.advance(ctx, actorOf(s), expect));
  });
  app.post("/api/queue/start", async (req, reply) => { const s = await requireStaff(ctx, req, reply); if (!s) return; return wrapQueue(reply, () => Q.startNext(ctx, actorOf(s))); });
  app.post("/api/queue/:id/no-show", async (req, reply) => { const s = await requireStaff(ctx, req, reply); if (!s) return; return wrapQueue(reply, () => Q.markNoShow(ctx, (req.params as { id: string }).id, actorOf(s), (req.body as { version?: number })?.version)); });
  app.post("/api/queue/:id/cancel", async (req, reply) => { const s = await requireStaff(ctx, req, reply); if (!s) return; return wrapQueue(reply, () => Q.cancelEntry(ctx, (req.params as { id: string }).id, actorOf(s), (req.body as { version?: number })?.version)); });
  app.post("/api/queue/:id/re-add", async (req, reply) => { const s = await requireStaff(ctx, req, reply); if (!s) return; return wrapQueue(reply, () => Q.readd(ctx, (req.params as { id: string }).id, actorOf(s))); });
  app.post("/api/queue/:id/undo", async (req, reply) => { const s = await requireStaff(ctx, req, reply); if (!s) return; return wrapQueue(reply, () => Q.undoStart(ctx, (req.params as { id: string }).id, actorOf(s))); });
  app.post("/api/queue/:id/move", async (req, reply) => {
    const s = await requireStaff(ctx, req, reply); if (!s) return;
    const dir = z.enum(["up", "down", "top"]).safeParse((req.body as { direction?: string })?.direction);
    if (!dir.success) return sendErr(reply, 400, "bad_direction");
    return wrapQueue(reply, () => Q.move(ctx, (req.params as { id: string }).id, dir.data, actorOf(s)));
  });
  app.post("/api/queue/walkin", async (req, reply) => {
    const s = await requireStaff(ctx, req, reply); if (!s) return;
    const b = z.object({ name: z.string().trim().min(1).max(60), phone: z.string().optional() }).safeParse(req.body);
    if (!b.success) return sendErr(reply, 400, "bad_request");
    const info = await clinicInfo(ctx);
    const board = await Q.boardSession(ctx, info);
    if (!board) return sendErr(reply, 409, "no_session");
    let profileId: string | null = null;
    const wa = b.data.phone ? normalizeIndianPhone(b.data.phone) : null;
    if (wa) { const acc = await findOrCreateAccount(ctx, wa); await ctx.db.patientAccount.update({ where: { id: acc.id }, data: { lastInboundAt: null } }); profileId = (await createProfile(ctx, acc.id, b.data.name, "SELF")).id; }
    await Q.issueWalkin(ctx, { sessionId: board.session.id, date: board.date, profileId, displayName: profileId ? null : b.data.name, actor: actorOf(s) });
    return Q.snapshot(ctx);
  });
  app.post("/api/queue/broadcast", async (req, reply) => {
    const s = await requireStaff(ctx, req, reply); if (!s) return;
    const b = z.object({ type: z.enum(["late", "pause", "resume"]), minutes: z.number().int().min(0).max(240).optional() }).safeParse(req.body);
    if (!b.success) return sendErr(reply, 400, "bad_request");
    const informed = b.data.type === "late" ? await Q.setDelay(ctx, b.data.minutes ?? 0, actorOf(s)) : await Q.setPause(ctx, b.data.type === "resume" ? 0 : b.data.minutes ?? 15, actorOf(s));
    return { informed };
  });
  app.post("/api/queue/close-today", async (req, reply) => {
    const s = await requireStaff(ctx, req, reply); if (!s) return;
    if (!(req.body as { confirm?: boolean })?.confirm) return { affected: await affectedByClosure(ctx, nowLocal(ctx).date, null) };
    return { affected: await applyClosure(ctx, { date: nowLocal(ctx).date, sessionId: null, label: "Closed today", actorId: s.id }) };
  });
  app.post("/api/overflow/:id/decide", async (req, reply) => {
    const s = await requireStaff(ctx, req, reply); if (!s) return;
    const b = z.object({ decision: z.enum(["yes", "no"]), time: z.string().regex(/^\d{2}:\d{2}$/).optional(), endOfQueue: z.boolean().optional() }).safeParse(req.body);
    if (!b.success) return sendErr(reply, 400, "bad_request");
    const d = b.data.decision === "no" ? { decision: "no" as const } : { decision: "yes" as const, time: b.data.time ? T.toInstant(nowLocal(ctx).date, b.data.time, ctx.tz) : null, endOfQueue: b.data.endOfQueue };
    const r = await decideOverflow(ctx, (req.params as { id: string }).id, d, { id: s.id, name: s.name });
    return r.ok ? { ok: true } : reply.code(409).send({ error: { code: "already_handled" } });
  });
  app.get("/api/overflow/pending", async (req, reply) => {
    if (!(await requireStaff(ctx, req, reply))) return;
    const doc = (await clinicInfo(ctx)).doctor.id;
    const rows = await ctx.db.walkinOverflowRequest.findMany({ where: { doctorId: doc, status: "PENDING" }, orderBy: { createdAt: "asc" } });
    const out = [];
    for (const r of rows) { const p = await ctx.db.patientProfile.findUnique({ where: { id: r.profileId } }); out.push({ id: r.id, name: p ? decrypt(p.name) : "Patient", expiresAt: r.expiresAt.toISOString() }); }
    return out;
  });

  // ── appointments ──
  app.get("/api/appointments", async (req, reply) => {
    if (!(await requireStaff(ctx, req, reply))) return;
    const q = req.query as { from?: string; to?: string };
    const n = nowLocal(ctx);
    const from = q.from ?? n.date; const to = q.to ?? T.addDays(n.date, 7);
    const docId = (await clinicInfo(ctx)).doctor.id;
    const rows = await ctx.db.appointment.findMany({
      where: { doctorId: docId, status: { in: ["BOOKED", "ARRIVED", "COMPLETED", "NO_SHOW"] }, slotStart: { gte: T.toInstant(from, "00:00", ctx.tz), lt: T.toInstant(T.addDays(to, 1), "00:00", ctx.tz) } },
      include: { profile: { include: { account: true } } }, orderBy: { slotStart: "asc" },
    });
    return rows.map((a) => ({
      id: a.id, date: T.localDate(a.slotStart, ctx.tz), time: T.fmtTime(T.localMinutes(a.slotStart, ctx.tz)), slotStart: a.slotStart.toISOString(),
      token: a.token, status: a.status, visitType: a.visitType, source: a.source,
      name: a.profile ? decrypt(a.profile.name) : "—", phone: a.profile?.account ? maskPhone(decrypt(a.profile.account.waPhone)) : null,
    }));
  });
  app.get("/api/slots", async (req, reply) => {
    if (!(await requireStaff(ctx, req, reply))) return;
    const date = (req.query as { date?: string }).date ?? nowLocal(ctx).date;
    const info = await clinicInfo(ctx);
    const av = await availability(ctx, info, date, date);
    return S.allSlotsOn(date, av).map((s) => ({ sessionLabel: s.sessionLabel, startMin: s.startMin, time: T.fmtTime(s.startMin), status: S.bookability(s, av) }));
  });
  app.post("/api/appointments", async (req, reply) => {
    const s = await requireStaff(ctx, req, reply); if (!s) return;
    const b = z.object({ name: z.string().trim().min(1).max(60), phone: z.string(), date: z.string(), startMin: z.number().int(), visitType: z.enum(["NEW", "FOLLOW_UP", "REPORT_SHOW"]).default("NEW") }).safeParse(req.body);
    if (!b.success) return sendErr(reply, 400, "bad_request");
    const wa = normalizeIndianPhone(b.data.phone);
    if (!wa) return sendErr(reply, 400, "bad_phone");
    const info = await clinicInfo(ctx);
    const av = await windowAvailability(ctx, info);
    const slot = S.findSlot(b.data.date, b.data.startMin, av);
    if (!slot || S.bookability(slot, { ...av, rules: { ...av.rules, cutoffMinutes: 0 } }) !== "ok") return sendErr(reply, 409, "slot_unavailable");
    const acc = await findOrCreateAccount(ctx, wa);
    if (!acc.lastInboundAt || acc.createdAt.getTime() === acc.lastInboundAt.getTime()) await ctx.db.patientAccount.update({ where: { id: acc.id }, data: { lastInboundAt: null } });
    const existing = (await ctx.db.patientProfile.findMany({ where: { accountId: acc.id } })).find((p) => decrypt(p.name).toLowerCase() === b.data.name.toLowerCase());
    const profileId = existing?.id ?? (await createProfile(ctx, acc.id, b.data.name, (await ctx.db.patientProfile.count({ where: { accountId: acc.id } })) ? "OTHER" : "SELF")).id;
    try {
      const held = await holdSlot(ctx, slot, profileId, acc.id);
      const appt = await confirmHold(ctx, held.id, b.data.visitType, "STAFF");
      const lang = acc.language;
      const vars = { name: firstName(b.data.name), dayShort: T.fmtDayShort(b.data.date, lang), time: T.fmtTime(b.data.startMin), token: appt.token ?? "", addressShort: info.clinic.addressShort, clinicName: info.clinic.name, mapsLine: "", apptId: appt.id };
      await sendToAccount(ctx, acc.id, { kind: "text", body: C.render("BOOKING_CONFIRMED", lang, vars) }, { kind: "BOOKING_CONFIRMED", template: { name: "appointment_confirmed", lang, vars } });
      return { id: appt.id, token: appt.token };
    } catch (e) {
      if (e instanceof SlotTakenError || e instanceof FamilySlotError) return sendErr(reply, 409, "slot_taken");
      throw e;
    }
  });
  app.post("/api/appointments/:id/arrive", async (req, reply) => { const s = await requireStaff(ctx, req, reply); if (!s) return; await Q.arriveAppointment(ctx, (req.params as { id: string }).id, actorOf(s)); return Q.snapshot(ctx); });
  app.post("/api/appointments/:id/cancel", async (req, reply) => {
    const s = await requireStaff(ctx, req, reply); if (!s) return;
    const a = await ctx.db.appointment.findUnique({ where: { id: (req.params as { id: string }).id }, include: { profile: true } });
    if (!a) return sendErr(reply, 404, "not_found");
    await cancelAppointment(ctx, a.id, "CLINIC", s.id);
    const info = await clinicInfo(ctx);
    if (a.profile?.accountId) {
      const acc = await ctx.db.patientAccount.findUniqueOrThrow({ where: { id: a.profile.accountId } });
      const vars = { name: firstName(decrypt(a.profile.name)), date: T.fmtDayShort(T.localDate(a.slotStart, ctx.tz), acc.language), time: T.fmtTime(T.localMinutes(a.slotStart, ctx.tz)), clinicPhone: info.clinic.phone };
      await sendToAccount(ctx, acc.id, { kind: "buttons", body: C.render("CANCELLED_BY_CLINIC", acc.language, vars), buttons: [{ id: "menu:book", title: C.btn("PICK_NEW_TIME", acc.language) }] }, { kind: "CANCELLED_BY_CLINIC", template: { name: "cancelled_by_clinic", lang: acc.language, vars } });
    }
    return { ok: true };
  });
  app.post("/api/appointments/:id/reschedule", async (req, reply) => {
    const s = await requireStaff(ctx, req, reply); if (!s) return;
    const b = z.object({ date: z.string(), startMin: z.number().int() }).safeParse(req.body);
    if (!b.success) return sendErr(reply, 400, "bad_request");
    const old = await ctx.db.appointment.findUnique({ where: { id: (req.params as { id: string }).id }, include: { profile: true } });
    if (!old?.profileId) return sendErr(reply, 404, "not_found");
    const info = await clinicInfo(ctx);
    const av = await windowAvailability(ctx, info);
    const slot = S.findSlot(b.data.date, b.data.startMin, av);
    if (!slot) return sendErr(reply, 409, "slot_unavailable");
    try {
      const held = await holdSlot(ctx, slot, old.profileId, null);
      const r = await reschedule(ctx, old.id, held.id);
      return { id: r.booked.id, token: r.booked.token };
    } catch (e) { if (e instanceof SlotTakenError || e instanceof FamilySlotError) return sendErr(reply, 409, "slot_taken"); throw e; }
  });
  app.post("/api/slots/block", async (req, reply) => {
    const s = await requireStaff(ctx, req, reply); if (!s) return;
    const b = z.object({ date: z.string(), startMin: z.number().int(), blocked: z.boolean() }).safeParse(req.body);
    if (!b.success) return sendErr(reply, 400, "bad_request");
    const info = await clinicInfo(ctx);
    const at = T.toInstant(b.data.date, b.data.startMin, ctx.tz);
    if (b.data.blocked) await ctx.db.blockedSlot.upsert({ where: { doctorId_slotStart: { doctorId: info.doctor.id, slotStart: at } }, create: { doctorId: info.doctor.id, slotStart: at, createdById: s.id }, update: {} });
    else await ctx.db.blockedSlot.deleteMany({ where: { doctorId: info.doctor.id, slotStart: at } });
    await audit(ctx, s.role, s.id, b.data.blocked ? "slot.block" : "slot.unblock", "BlockedSlot", null, { at: at.toISOString() });
    return { ok: true };
  });

  // ── settings (doctor only) ──
  app.get("/api/settings/clinic", async (req, reply) => {
    if (!(await requireStaff(ctx, req, reply, "DOCTOR"))) return;
    const info = await clinicInfo(ctx);
    const c = info.clinic;
    return { name: c.name, addressShort: c.addressShort, addressFull: c.addressFull, mapsUrl: c.mapsUrl, phone: c.phone, code: c.code, noticeUrl: c.noticeUrl, grievanceContact: c.grievanceContact, doctorName: info.doctor.displayName, qualification: info.doctor.qualification, settings: info.settings };
  });
  app.put("/api/settings/clinic", async (req, reply) => {
    const s = await requireStaff(ctx, req, reply, "DOCTOR"); if (!s) return;
    const b = z.object({
      name: z.string().min(1).max(80).optional(), addressShort: z.string().max(80).optional(), addressFull: z.string().max(300).optional(), mapsUrl: z.string().url().nullable().optional(),
      phone: z.string().max(20).optional(), noticeUrl: z.string().max(200).optional(), doctorName: z.string().max(60).optional(), qualification: z.string().max(100).nullable().optional(),
      settings: z.record(z.string(), z.unknown()).optional(),
    }).safeParse(req.body);
    if (!b.success) return sendErr(reply, 400, "bad_request");
    const info = await clinicInfo(ctx);
    const settings = b.data.settings ? ClinicSettings.safeParse({ ...info.settings, ...b.data.settings }) : null;
    if (settings && !settings.success) return sendErr(reply, 400, "bad_settings");
    const { doctorName, qualification, settings: _s, ...clinicData } = b.data;
    await ctx.db.clinic.update({ where: { id: info.clinic.id }, data: { ...clinicData, ...(settings?.success ? { settings: settings.data as never } : {}) } });
    if (doctorName || qualification !== undefined) await ctx.db.doctor.update({ where: { id: info.doctor.id }, data: { ...(doctorName ? { displayName: doctorName } : {}), ...(qualification !== undefined ? { qualification } : {}) } });
    await audit(ctx, "DOCTOR", s.id, "settings.update", "Clinic", info.clinic.id, { keys: Object.keys(b.data) });
    invalidateClinicCache();
    return { ok: true };
  });
  app.get("/api/settings/sessions", async (req, reply) => { if (!(await requireStaff(ctx, req, reply, "DOCTOR"))) return; const info = await clinicInfo(ctx); return ctx.db.session.findMany({ where: { doctorId: info.doctor.id }, orderBy: [{ weekday: "asc" }, { startTime: "asc" }] }); });
  app.put("/api/settings/sessions", async (req, reply) => {
    const s = await requireStaff(ctx, req, reply, "DOCTOR"); if (!s) return;
    const Sess = z.object({ weekday: z.number().int().min(0).max(6), label: z.string().min(1).max(20), startTime: z.string().regex(/^\d{2}:\d{2}$/), endTime: z.string().regex(/^\d{2}:\d{2}$/), slotMinutes: z.number().int().min(1).max(120), maxSlots: z.number().int().min(1).max(300).nullable().optional(), walkinQuota: z.number().int().min(0).max(200) });
    const b = z.array(Sess).safeParse(req.body);
    if (!b.success) return sendErr(reply, 400, "bad_request");
    for (const x of b.data) if (T.toMin(x.endTime) <= T.toMin(x.startTime)) return sendErr(reply, 400, "end_before_start");
    for (let wd = 0; wd < 7; wd++) {
      const day = b.data.filter((x) => x.weekday === wd).sort((a, c) => T.toMin(a.startTime) - T.toMin(c.startTime));
      for (let i = 1; i < day.length; i++) if (T.toMin(day[i]!.startTime) < T.toMin(day[i - 1]!.endTime)) return sendErr(reply, 400, "overlap");
    }
    const info = await clinicInfo(ctx);
    // keep ids for unchanged sessions (appointments reference sessionId)
    const existing = await ctx.db.session.findMany({ where: { doctorId: info.doctor.id } });
    const keep = new Set<string>();
    for (const x of b.data) {
      const same = existing.find((e) => e.weekday === x.weekday && e.startTime === x.startTime && !keep.has(e.id));
      if (same) { keep.add(same.id); await ctx.db.session.update({ where: { id: same.id }, data: { ...x, active: true } }); }
      else keep.add((await ctx.db.session.create({ data: { ...x, doctorId: info.doctor.id } })).id);
    }
    await ctx.db.session.updateMany({ where: { doctorId: info.doctor.id, id: { notIn: [...keep] } }, data: { active: false } });
    await audit(ctx, "DOCTOR", s.id, "settings.sessions", "Session", null, { count: b.data.length });
    invalidateClinicCache();
    return { ok: true };
  });
  app.get("/api/settings/closures", async (req, reply) => { if (!(await requireStaff(ctx, req, reply))) return; const info = await clinicInfo(ctx); return ctx.db.closure.findMany({ where: { doctorId: info.doctor.id, date: { gte: T.dateToDb(nowLocal(ctx).date) } }, orderBy: { date: "asc" } }); });
  app.post("/api/settings/closures", async (req, reply) => {
    const s = await requireStaff(ctx, req, reply, "DOCTOR"); if (!s) return;
    const b = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), sessionId: z.string().nullable().default(null), label: z.string().max(40).optional(), confirm: z.boolean().default(false) }).safeParse(req.body);
    if (!b.success) return sendErr(reply, 400, "bad_request");
    if (!b.data.confirm) return { affectedAppointments: await affectedByClosure(ctx, b.data.date, b.data.sessionId) };
    return { affected: await applyClosure(ctx, { date: b.data.date, sessionId: b.data.sessionId, label: b.data.label, actorId: s.id }) };
  });
  app.delete("/api/settings/closures/:id", async (req, reply) => { const s = await requireStaff(ctx, req, reply, "DOCTOR"); if (!s) return; await ctx.db.closure.delete({ where: { id: (req.params as { id: string }).id } }); await audit(ctx, "DOCTOR", s.id, "closure.remove", "Closure", (req.params as { id: string }).id); return { ok: true }; });
  app.get("/api/settings/staff", async (req, reply) => {
    if (!(await requireStaff(ctx, req, reply, "DOCTOR"))) return;
    const rows = await ctx.db.staffUser.findMany({ where: { clinicId: (await clinicInfo(ctx)).clinic.id }, orderBy: { name: "asc" } });
    return rows.map((r) => ({ id: r.id, name: r.name, role: r.role, onDuty: r.onDuty, active: r.active, phone: maskPhone(decrypt(r.waPhone)) }));
  });
  app.post("/api/settings/staff", async (req, reply) => {
    const s = await requireStaff(ctx, req, reply, "DOCTOR"); if (!s) return;
    const b = z.object({ name: z.string().min(1).max(60), phone: z.string(), role: z.enum(["DOCTOR", "STAFF"]).default("STAFF") }).safeParse(req.body);
    const wa = b.success ? normalizeIndianPhone(b.data.phone) : null;
    if (!b.success || !wa) return sendErr(reply, 400, "bad_request");
    const info = await clinicInfo(ctx);
    const u = await ctx.db.staffUser.upsert({ where: { phoneHash: phoneHash(wa) }, create: { clinicId: info.clinic.id, name: b.data.name, waPhone: encrypt(wa), phoneHash: phoneHash(wa), role: b.data.role }, update: { name: b.data.name, role: b.data.role, active: true } });
    await audit(ctx, "DOCTOR", s.id, "staff.upsert", "StaffUser", u.id);
    return { id: u.id };
  });
  app.patch("/api/settings/staff/:id", async (req, reply) => {
    const s = await requireStaff(ctx, req, reply, "DOCTOR"); if (!s) return;
    const b = z.object({ onDuty: z.boolean().optional(), active: z.boolean().optional() }).safeParse(req.body);
    if (!b.success) return sendErr(reply, 400, "bad_request");
    await ctx.db.staffUser.update({ where: { id: (req.params as { id: string }).id }, data: b.data });
    await audit(ctx, "DOCTOR", s.id, "staff.update", "StaffUser", (req.params as { id: string }).id, b.data);
    return { ok: true };
  });
  app.get("/api/settings/qr", async (req, reply) => {
    if (!(await requireStaff(ctx, req, reply))) return;
    const link = await walkinLink(ctx, ctx.env.WA_DISPLAY_NUMBER || "910000000000");
    return { ...link, png: await QRCode.toDataURL(link.url, { margin: 1, width: 512 }) };
  });
  app.get("/api/settings/display-key", async (req, reply) => { if (!(await requireStaff(ctx, req, reply, "DOCTOR"))) return; return { key: (await clinicInfo(ctx)).clinic.displayKey }; });

  // ── Demo Studio (operator/admin; enabled with DEMO_STUDIO=true) ──
  const DemoIn = z.object({ name: z.string().trim().min(2).max(80), website: z.string().trim().max(300).optional().or(z.literal("")), details: z.string().max(8000).optional(), doctorName: z.string().max(60).optional(), specialty: z.string().max(60).optional() });
  const demoGuard = async (req: Parameters<typeof requireStaff>[1], reply: FastifyReply) => {
    if (!ctx.env.DEMO_STUDIO) { sendErr(reply, 404, "not_found"); return null; }
    return requireIncoloAdmin(ctx, req, reply);
  };
  app.get("/api/demo", async (req, reply) => {
    if (!(await demoGuard(req, reply))) return;
    const active = (await clinicInfo(ctx)).clinic.id;
    const rows = await ctx.db.clinic.findMany({ orderBy: { createdAt: "desc" }, include: { doctors: true } });
    return rows.map((c) => ({ id: c.id, name: c.name, isDemo: c.isDemo, active: c.id === active, doctor: c.doctors[0]?.displayName ?? "", addressShort: c.addressShort, createdAt: c.createdAt.toISOString(), source: c.demoSource }));
  });
  app.post("/api/demo/preview", async (req, reply) => {
    if (!(await demoGuard(req, reply))) return;
    const b = DemoIn.safeParse(req.body);
    if (!b.success) return sendErr(reply, 400, "bad_request");
    if (!b.data.website && !b.data.details) return { profile: null };
    return extractProfile(ctx, { ...b.data, website: b.data.website || undefined });
  });
  app.post("/api/demo", async (req, reply) => {
    const s = await demoGuard(req, reply); if (!s) return;
    const b = z.object({ input: DemoIn, profile: z.record(z.string(), z.unknown()).optional() }).safeParse(req.body);
    if (!b.success) return sendErr(reply, 400, "bad_request");
    const r = await createDemo(ctx, { ...b.data.input, website: b.data.input.website || undefined }, s.id, b.data.profile as Partial<ClinicProfile> | undefined);
    return { id: r.clinic.id, name: r.clinic.name, profile: r.profile };
  });
  app.post("/api/demo/:id/activate", async (req, reply) => { const s = await demoGuard(req, reply); if (!s) return; await activateDemo(ctx, (req.params as { id: string }).id, s.id); return { ok: true }; });
  app.post("/api/demo/:id/reset", async (req, reply) => { const s = await demoGuard(req, reply); if (!s) return; await resetDemo(ctx, (req.params as { id: string }).id, s.id); return { ok: true }; });
  app.delete("/api/demo/:id", async (req, reply) => {
    const s = await demoGuard(req, reply); if (!s) return;
    try { await deleteDemo(ctx, (req.params as { id: string }).id, s.id); return { ok: true }; } catch { return sendErr(reply, 409, "not_demo"); }
  });
  app.get("/api/demo/kit", async (req, reply) => {
    if (!(await demoGuard(req, reply))) return;
    const info = await clinicInfo(ctx);
    const num = ctx.env.WA_DISPLAY_NUMBER || "910000000000";
    const chatUrl = `https://wa.me/${num}?text=${encodeURIComponent("Hi")}`;
    const walk = await walkinLink(ctx, num);
    const base = `${ctx.env.PUBLIC_BASE_URL}${ctx.env.BASE_PATH}`;
    return {
      clinicName: info.clinic.name, doctor: info.doctor.displayName, waNumber: num, chatUrl, chatQr: await QRCode.toDataURL(chatUrl, { margin: 1, width: 420 }),
      walkinText: walk.text, walkinQr: await QRCode.toDataURL(walk.url, { margin: 1, width: 420 }),
      dashboardUrl: `${base}/`, displayUrl: `${base}/display?key=${encodeURIComponent(info.clinic.displayKey)}`,
    };
  });

  // ── language model (Incolo internal admins only) ──
  app.get("/api/settings/ai", async (req, reply) => {
    if (!(await requireIncoloAdmin(ctx, req, reply))) return;
    return { config: await ai.config(), catalog: ai.catalog() };
  });
  app.put("/api/settings/ai", async (req, reply) => {
    const s = await requireIncoloAdmin(ctx, req, reply); if (!s) return;
    const r = await ai.update(req.body, s.id);
    return r.saved ? r : reply.code(422).send(r);
  });

  // ── reports (aggregates only) ──
  app.get("/api/reports/summary", async (req, reply) => {
    if (!(await requireStaff(ctx, req, reply, "DOCTOR"))) return;
    const q = req.query as { from?: string; to?: string };
    const n = nowLocal(ctx);
    const from = q.from ?? T.addDays(n.date, -29); const to = q.to ?? n.date;
    const range = { gte: T.toInstant(from, "00:00", ctx.tz), lt: T.toInstant(T.addDays(to, 1), "00:00", ctx.tz) };
    const docR = (await clinicInfo(ctx)).doctor.id;
    const appts = await ctx.db.appointment.findMany({ where: { doctorId: docR, slotStart: range, status: { in: ["BOOKED", "ARRIVED", "COMPLETED", "NO_SHOW", "CANCELLED"] }, bookedAt: { not: null } }, select: { slotStart: true, status: true } });
    const entries = await ctx.db.queueEntry.findMany({ where: { doctorId: docR, arrivedAt: range }, select: { source: true, state: true, arrivedAt: true, consultStartedAt: true, completedAt: true } });
    const byDay: Record<string, { booked: number; walkins: number; completed: number; noShow: number }> = {};
    const day = (d: Date) => T.localDate(d, ctx.tz);
    for (const a of appts) { const k = day(a.slotStart); byDay[k] ??= { booked: 0, walkins: 0, completed: 0, noShow: 0 }; byDay[k].booked++; if (a.status === "NO_SHOW") byDay[k].noShow++; }
    for (const e of entries) { const k = day(e.arrivedAt); byDay[k] ??= { booked: 0, walkins: 0, completed: 0, noShow: 0 }; if (e.source === "W") byDay[k].walkins++; if (e.state === "COMPLETED") byDay[k].completed++; }
    const waits = entries.filter((e) => e.consultStartedAt).map((e) => (e.consultStartedAt!.getTime() - e.arrivedAt.getTime()) / 60_000);
    const hours: Record<number, number> = {};
    for (const e of entries) { const h = Math.floor(T.localMinutes(e.arrivedAt, ctx.tz) / 60); hours[h] = (hours[h] ?? 0) + 1; }
    const total = appts.length;
    return { from, to, byDay, peakHours: hours, avgWaitMin: waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : null, noShowRate: total ? Math.round((1000 * appts.filter((a) => a.status === "NO_SHOW").length) / total) / 10 : null };
  });

  // ── TV display (read-only, display key) ──
  app.get("/api/display/state", async (req, reply) => {
    const key = (req.query as { key?: string }).key;
    const info = await clinicInfo(ctx);
    if (!key || key !== info.clinic.displayKey) return sendErr(reply, 401, "bad_key");
    const s = await Q.snapshot(ctx);
    const show = info.settings.display.showFirstName;
    const v = (e: Q.EntryView | null) => (e ? { token: e.token, firstName: show ? e.firstName : null } : null);
    return { clinicName: info.clinic.name, session: s.session?.label ?? null, inConsult: v(s.inConsult), next: v(s.next), waiting: s.waiting.slice(0, 5).map(v), delayMin: s.delayMin, pauseUntil: s.pauseUntil, voiceCallout: info.settings.display.voiceCallout };
  });

  void displayPhone;
}
