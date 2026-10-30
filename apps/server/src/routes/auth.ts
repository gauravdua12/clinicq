import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { copy } from "@clinicq/core";
import { decrypt, encrypt, normalizeIndianPhone, phoneHash, type StaffUser } from "@clinicq/db";
import type { Ctx } from "../context";
import { sendTo } from "../services/notify";
import { ensureAdmins, isIncoloAdmin } from "../services/admins";
import { isManager } from "../services/staff";
import { clinicActive } from "../services/tenancy";
import { inScope } from "../scope";

// Staff login: WhatsApp OTP (auth template) → httpOnly session cookie (PRD DB-01).

const SESSION_HOURS = 12;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

declare module "fastify" { interface FastifyRequest { staff?: StaffUser } }

/** A signed-in clinic login; "MANAGE" = the clinic's doctor or clinic admin. */
export async function requireStaff(ctx: Ctx, req: FastifyRequest, reply: FastifyReply, role?: "MANAGE"): Promise<StaffUser | null> {
  const sid = req.cookies?.sid;
  if (!sid) { reply.code(401).send({ error: { code: "unauthenticated" } }); return null; }
  const s = await ctx.db.staffSession.findUnique({ where: { id: sha(sid) } });
  if (!s || s.expiresAt < ctx.clock.now()) { reply.code(401).send({ error: { code: "unauthenticated" } }); return null; }
  const staff = await ctx.db.staffUser.findUnique({ where: { id: s.staffId } });
  if (!staff?.active) { reply.code(401).send({ error: { code: "unauthenticated" } }); return null; }
  if (role === "MANAGE" && !isManager(staff)) { reply.code(403).send({ error: { code: "forbidden" } }); return null; }
  req.staff = staff;
  return staff;
}

/** Incolo's own admins (services/admins.ts): the admin portal. A clinic's doctor manages their clinic, never the platform. */
export async function requireIncoloAdmin(ctx: Ctx, req: FastifyRequest, reply: FastifyReply): Promise<StaffUser | null> {
  const s = await requireStaff(ctx, req, reply);
  if (!s) return null;
  if (!(await isIncoloAdmin(ctx, s))) { reply.code(403).send({ error: { code: "forbidden" } }); return null; }
  return s;
}

/** The Meta App Review login (REVIEWER_PHONE + REVIEWER_CODE), or null when it's switched off. */
function reviewer(ctx: Ctx): { wa: string; code: string } | null {
  const wa = normalizeIndianPhone(ctx.env.REVIEWER_PHONE);
  return wa && ctx.env.REVIEWER_CODE ? { wa, code: ctx.env.REVIEWER_CODE } : null;
}

/**
 * At boot: the reviewer's staff account in the active clinic (role STAFF, never on duty, never an Incolo admin), or, when
 * the reviewer login is switched off, that account deactivated.
 */
export async function ensureReviewer(ctx: Ctx): Promise<void> {
  const r = reviewer(ctx);
  const wa = normalizeIndianPhone(ctx.env.REVIEWER_PHONE);
  if (!r) { if (wa) await ctx.db.staffUser.updateMany({ where: { phoneHash: phoneHash(wa) }, data: { active: false } }); return; }
  const { clinicInfo } = await import("../services/clinic");
  const { clinic } = await clinicInfo(ctx);
  await ctx.db.staffUser.upsert({
    where: { phoneHash: phoneHash(r.wa) },
    create: { clinicId: clinic.id, name: "App Reviewer", waPhone: encrypt(r.wa), phoneHash: phoneHash(r.wa), role: "STAFF", onDuty: false },
    update: { active: true, onDuty: false, role: "STAFF" },
  });
}

async function startSession(ctx: Ctx, reply: FastifyReply, staffId: string): Promise<void> {
  const sid = randomBytes(32).toString("base64url");
  await ctx.db.staffSession.create({ data: { id: sha(sid), staffId, expiresAt: new Date(ctx.clock.now().getTime() + SESSION_HOURS * 3600_000) } });
  reply.setCookie("sid", sid, { httpOnly: true, sameSite: "strict", secure: ctx.env.NODE_ENV === "production", path: ctx.env.BASE_PATH || "/", maxAge: SESSION_HOURS * 3600 });
}

export async function authRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  app.post("/api/auth/otp", async (req) => {
    const wa = normalizeIndianPhone(String((req.body as { phone?: string })?.phone ?? ""));
    if (!wa) return { ok: true };
    const staff = await ctx.db.staffUser.findUnique({ where: { phoneHash: phoneHash(wa) } });
    if (!staff?.active || !(await clinicActive(ctx, staff.clinicId))) return { ok: true }; // no enumeration; a paused clinic can't sign in
    const recent = await ctx.db.otpChallenge.findUnique({ where: { phoneHash: staff.phoneHash } });
    if (recent && recent.expiresAt.getTime() - ctx.clock.now().getTime() > 4 * 60_000) return { ok: true }; // throttle: 1/min
    // The App Review login: its fixed code is checked like any other, and nothing is sent on WhatsApp.
    const rv = reviewer(ctx);
    const code = rv && rv.wa === wa ? rv.code : String(randomInt(100000, 1000000));
    await ctx.db.otpChallenge.upsert({ where: { phoneHash: staff.phoneHash }, create: { phoneHash: staff.phoneHash, codeHash: sha(code), expiresAt: new Date(ctx.clock.now().getTime() + 5 * 60_000) }, update: { codeHash: sha(code), attempts: 0, expiresAt: new Date(ctx.clock.now().getTime() + 5 * 60_000) } });
    if (rv && rv.wa === wa) return { ok: true };
    const to = decrypt(staff.waPhone);
    // From the clinic's own number once it's connected; before that (or for demo clinics) from the shared number. A solo
    // doctor often signs in with the clinic's own number, and a number can't message itself: that code comes from the
    // shared number too.
    const conn = await ctx.db.waConnection.findUnique({ where: { clinicId: staff.clinicId }, select: { status: true, displayPhone: true } });
    const ownNumber = conn?.status === "CONNECTED" && normalizeIndianPhone(conn.displayPhone ?? "") !== wa;
    const sendScope = { clinicId: ownNumber ? staff.clinicId : null };
    const sent = await inScope(sendScope, () => sendTo(ctx, to, { kind: "template", name: "staff_login_otp", lang: "en", bodyParams: [code], otpCode: code }, { kind: "staff_login_otp" }));
    // Until Meta approves the authentication template, a plain message still works if this person messaged the bot in the last 24 h.
    if (!sent) await inScope(sendScope, () => sendTo(ctx, to, { kind: "text", body: copy.render("STAFF_OTP_TEXT", "en", { code }) }, { kind: "staff_login_otp_text" }));
    return { ok: true };
  });

  app.post("/api/auth/verify", async (req, reply) => {
    const b = req.body as { phone?: string; code?: string };
    const wa = normalizeIndianPhone(String(b?.phone ?? ""));
    const staff = wa ? await ctx.db.staffUser.findUnique({ where: { phoneHash: phoneHash(wa) } }) : null;
    const ch = staff ? await ctx.db.otpChallenge.findUnique({ where: { phoneHash: staff.phoneHash } }) : null;
    if (!staff?.active || !(await clinicActive(ctx, staff.clinicId)) || !ch || ch.expiresAt < ctx.clock.now() || ch.attempts >= 5) return reply.code(401).send({ error: { code: "invalid_code" } });
    const ok = timingSafeEqual(Buffer.from(sha(String(b.code ?? ""))), Buffer.from(ch.codeHash));
    if (!ok) { await ctx.db.otpChallenge.update({ where: { phoneHash: ch.phoneHash }, data: { attempts: { increment: 1 } } }); return reply.code(401).send({ error: { code: "invalid_code" } }); }
    await ctx.db.otpChallenge.delete({ where: { phoneHash: ch.phoneHash } });
    await startSession(ctx, reply, staff.id);
    return { name: staff.name, role: staff.role, incoloAdmin: await isIncoloAdmin(ctx, staff) };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const sid = req.cookies?.sid;
    if (sid) await ctx.db.staffSession.deleteMany({ where: { id: sha(sid) } });
    reply.clearCookie("sid", { path: ctx.env.BASE_PATH || "/" });
    return { ok: true };
  });

  app.get("/api/me", async (req, reply) => {
    const s = await requireStaff(ctx, req, reply);
    return s ? { name: s.name, role: s.role, incoloAdmin: await isIncoloAdmin(ctx, s) } : undefined;
  });

  if (ctx.env.DEV_TOOLS && ctx.env.NODE_ENV !== "production") {
    app.post("/api/auth/dev-login", async (req, reply) => {
      const asked = (req.body as { role?: string })?.role;
      let staff: StaffUser | null;
      if (asked === "INCOLO") {
        // An Incolo admin for trying the admin portal locally (a made-up number).
        const wa = "919999900009";
        await ctx.db.incoloAdmin.upsert({ where: { phoneHash: phoneHash(wa) }, create: { name: "Incolo admin (dev)", waPhone: encrypt(wa), phoneHash: phoneHash(wa) }, update: { active: true } });
        await ensureAdmins(ctx);
        staff = await ctx.db.staffUser.findUnique({ where: { phoneHash: phoneHash(wa) } });
      } else {
        const role = asked === "STAFF" ? "STAFF" : asked === "CLINIC_ADMIN" ? "CLINIC_ADMIN" : "DOCTOR";
        const admins = (await ctx.db.incoloAdmin.findMany({ select: { phoneHash: true } })).map((a) => a.phoneHash);
        const { clinicInfo } = await import("../services/clinic");
        const where = { role, active: true, phoneHash: { notIn: admins } } as const;
        const clinicId = (await clinicInfo(ctx).catch(() => null))?.clinic.id;
        staff = (await ctx.db.staffUser.findFirst({ where: { ...where, clinicId: clinicId ?? "-" } }))
          ?? (await ctx.db.staffUser.findFirst({ where, orderBy: { name: "asc" } }));
        if (!staff && role === "CLINIC_ADMIN" && clinicId) { // the demo seed has none: a made-up one for trying the role
          const wa = "919999900008";
          staff = await ctx.db.staffUser.upsert({ where: { phoneHash: phoneHash(wa) }, create: { clinicId, name: "Kavita (clinic admin)", waPhone: encrypt(wa), phoneHash: phoneHash(wa), role: "CLINIC_ADMIN" }, update: { clinicId, role: "CLINIC_ADMIN", active: true } });
        }
      }
      if (!staff) return reply.code(404).send();
      await startSession(ctx, reply, staff.id);
      return { name: staff.name, role: staff.role, incoloAdmin: await isIncoloAdmin(ctx, staff) };
    });
  }
}
