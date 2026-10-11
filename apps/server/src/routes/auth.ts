import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { copy } from "@clinicq/core";
import { decrypt, normalizeIndianPhone, phoneHash, type StaffUser } from "@clinicq/db";
import type { Ctx } from "../context";
import { sendTo } from "../services/notify";

// Staff login: WhatsApp OTP (auth template) → httpOnly session cookie (PRD DB-01).

const SESSION_HOURS = 12;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

declare module "fastify" { interface FastifyRequest { staff?: StaffUser } }

export async function requireStaff(ctx: Ctx, req: FastifyRequest, reply: FastifyReply, role?: "DOCTOR"): Promise<StaffUser | null> {
  const sid = req.cookies?.sid;
  if (!sid) { reply.code(401).send({ error: { code: "unauthenticated" } }); return null; }
  const s = await ctx.db.staffSession.findUnique({ where: { id: sha(sid) } });
  if (!s || s.expiresAt < ctx.clock.now()) { reply.code(401).send({ error: { code: "unauthenticated" } }); return null; }
  const staff = await ctx.db.staffUser.findUnique({ where: { id: s.staffId } });
  if (!staff?.active) { reply.code(401).send({ error: { code: "unauthenticated" } }); return null; }
  if (role === "DOCTOR" && staff.role !== "DOCTOR") { reply.code(403).send({ error: { code: "forbidden" } }); return null; }
  req.staff = staff;
  return staff;
}

/**
 * Incolo's internal admins (INCOLO_ADMIN_PHONES): the only people who see the language-model settings and Demo Studio.
 * A clinic's doctor is an admin of their clinic, not of the platform. On a dev machine (dev tools, not production)
 * doctors count as internal admins so everything can be tried locally.
 */
export function isIncoloAdmin(ctx: Ctx, staff: StaffUser): boolean {
  const list = ctx.env.INCOLO_ADMIN_PHONES.split(",").map((p) => normalizeIndianPhone(p)).filter(Boolean);
  if (list.includes(decrypt(staff.waPhone))) return true;
  return ctx.env.DEV_TOOLS && ctx.env.NODE_ENV !== "production" && staff.role === "DOCTOR";
}

export async function requireIncoloAdmin(ctx: Ctx, req: FastifyRequest, reply: FastifyReply): Promise<StaffUser | null> {
  const s = await requireStaff(ctx, req, reply);
  if (!s) return null;
  if (!isIncoloAdmin(ctx, s)) { reply.code(403).send({ error: { code: "forbidden" } }); return null; }
  return s;
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
    if (!staff?.active) return { ok: true }; // no enumeration
    const recent = await ctx.db.otpChallenge.findUnique({ where: { phoneHash: staff.phoneHash } });
    if (recent && recent.expiresAt.getTime() - ctx.clock.now().getTime() > 4 * 60_000) return { ok: true }; // throttle: 1/min
    const code = String(randomInt(100000, 1000000));
    await ctx.db.otpChallenge.upsert({ where: { phoneHash: staff.phoneHash }, create: { phoneHash: staff.phoneHash, codeHash: sha(code), expiresAt: new Date(ctx.clock.now().getTime() + 5 * 60_000) }, update: { codeHash: sha(code), attempts: 0, expiresAt: new Date(ctx.clock.now().getTime() + 5 * 60_000) } });
    const to = decrypt(staff.waPhone);
    const sent = await sendTo(ctx, to, { kind: "template", name: "staff_login_otp", lang: "en", bodyParams: [code], otpCode: code }, { kind: "staff_login_otp" });
    // Until Meta approves the authentication template, a plain message still works if this person messaged the bot in the last 24 h.
    if (!sent) await sendTo(ctx, to, { kind: "text", body: copy.render("STAFF_OTP_TEXT", "en", { code }) }, { kind: "staff_login_otp_text" });
    return { ok: true };
  });

  app.post("/api/auth/verify", async (req, reply) => {
    const b = req.body as { phone?: string; code?: string };
    const wa = normalizeIndianPhone(String(b?.phone ?? ""));
    const staff = wa ? await ctx.db.staffUser.findUnique({ where: { phoneHash: phoneHash(wa) } }) : null;
    const ch = staff ? await ctx.db.otpChallenge.findUnique({ where: { phoneHash: staff.phoneHash } }) : null;
    if (!staff?.active || !ch || ch.expiresAt < ctx.clock.now() || ch.attempts >= 5) return reply.code(401).send({ error: { code: "invalid_code" } });
    const ok = timingSafeEqual(Buffer.from(sha(String(b.code ?? ""))), Buffer.from(ch.codeHash));
    if (!ok) { await ctx.db.otpChallenge.update({ where: { phoneHash: ch.phoneHash }, data: { attempts: { increment: 1 } } }); return reply.code(401).send({ error: { code: "invalid_code" } }); }
    await ctx.db.otpChallenge.delete({ where: { phoneHash: ch.phoneHash } });
    await startSession(ctx, reply, staff.id);
    return { name: staff.name, role: staff.role };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const sid = req.cookies?.sid;
    if (sid) await ctx.db.staffSession.deleteMany({ where: { id: sha(sid) } });
    reply.clearCookie("sid", { path: ctx.env.BASE_PATH || "/" });
    return { ok: true };
  });

  app.get("/api/me", async (req, reply) => {
    const s = await requireStaff(ctx, req, reply);
    return s ? { name: s.name, role: s.role, incoloAdmin: isIncoloAdmin(ctx, s) } : undefined;
  });

  if (ctx.env.DEV_TOOLS && ctx.env.NODE_ENV !== "production") {
    app.post("/api/auth/dev-login", async (req, reply) => {
      const role = (req.body as { role?: string })?.role === "STAFF" ? "STAFF" : "DOCTOR";
      const { clinicInfo } = await import("../services/clinic");
      const staff = (await ctx.db.staffUser.findFirst({ where: { clinicId: (await clinicInfo(ctx).catch(() => null))?.clinic.id ?? "-", role, active: true } }))
        ?? (await ctx.db.staffUser.findFirst({ where: { role, active: true }, orderBy: { name: "asc" } }));
      if (!staff) return reply.code(404).send();
      await startSession(ctx, reply, staff.id);
      return { name: staff.name, role: staff.role };
    });
  }
}
