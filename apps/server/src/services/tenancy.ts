import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Ctx } from "../context";
import { scopeOfChannel, type Scope } from "../scope";

// Where work enters the server, find which clinic it belongs to (src/scope.ts).

const DEMO: Scope = { clinicId: null };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const byNumber = new Map<string, { at: number; scope: Scope | "ignore" }>();
export function invalidateNumberCache(): void { byNumber.clear(); }

// A customer clinic Incolo suspended or archived: nothing of it runs (logins, bot, sends, jobs, public pages).
const statusCache = new Map<string, { at: number; active: boolean }>();
export function invalidateClinicStatus(): void { statusCache.clear(); }
export async function clinicActive(ctx: Ctx, clinicId: string): Promise<boolean> {
  const hit = statusCache.get(clinicId);
  if (hit && Date.now() - hit.at < 5_000) return hit.active;
  const c = await ctx.db.clinic.findUnique({ where: { id: clinicId }, select: { status: true } });
  const active = c?.status === "ACTIVE";
  statusCache.set(clinicId, { at: Date.now(), active });
  return active;
}

/**
 * A webhook message's business number: a connected customer clinic's own number → that clinic; a number that was
 * disconnected → ignored (it's no longer ours to answer); anything else (the shared demo number, tests) → demo scope.
 */
export async function scopeForNumber(ctx: Ctx, phoneNumberId: string | undefined): Promise<Scope | "ignore"> {
  if (!phoneNumberId) return DEMO;
  const hit = byNumber.get(phoneNumberId);
  if (hit && Date.now() - hit.at < 60_000) return hit.scope;
  const conn = await ctx.db.waConnection.findUnique({ where: { phoneNumberId } });
  const scope: Scope | "ignore" = !conn ? DEMO : conn.status === "CONNECTED" && (await clinicActive(ctx, conn.clinicId)) ? { clinicId: conn.clinicId } : "ignore";
  byNumber.set(phoneNumberId, { at: Date.now(), scope });
  return scope;
}

/** A clinic's scope: its own when it runs on its own number, else the shared demo number's. */
async function scopeOfClinic(ctx: Ctx, clinicId: string | null | undefined): Promise<Scope> {
  if (!clinicId) return DEMO;
  const c = await ctx.db.clinic.findUnique({ where: { id: clinicId }, select: { ownNumber: true } });
  return c?.ownNumber ? { clinicId } : DEMO;
}

/**
 * A dashboard or public-page request: the signed-in staff member's clinic; the TV display's key; the patient's booking
 * or pay page token. Requests that name none of these (login, policy pages, the demo) use the demo scope.
 */
export async function scopeForRequest(ctx: Ctx, req: FastifyRequest): Promise<Scope> {
  const url = req.url.slice(ctx.env.BASE_PATH.length);
  const book = url.match(/^\/api\/book\/([A-Za-z0-9_-]{20,64})/);
  if (book) {
    const row = await ctx.db.flowToken.findUnique({ where: { token: book[1]! } });
    const acc = row ? await ctx.db.patientAccount.findUnique({ where: { id: row.accountId }, select: { channel: true } }) : null;
    return acc ? scopeOfChannel(acc.channel) : DEMO;
  }
  const pay = url.match(/^\/api\/pay\/([A-Za-z0-9_-]{8,40})/);
  if (pay) {
    const due = await ctx.db.paymentDue.findUnique({ where: { payToken: pay[1]! }, select: { doctorId: true } });
    const doc = due ? await ctx.db.doctor.findUnique({ where: { id: due.doctorId }, select: { clinicId: true } }) : null;
    return scopeOfClinic(ctx, doc?.clinicId);
  }
  if (url.startsWith("/api/display/")) {
    const key = (req.query as { key?: string } | undefined)?.key;
    const c = key ? await ctx.db.clinic.findUnique({ where: { displayKey: key }, select: { id: true, ownNumber: true } }) : null;
    return c?.ownNumber ? { clinicId: c.id } : DEMO;
  }
  const sid = req.cookies?.sid;
  if (sid && url.startsWith("/api/")) {
    const s = await ctx.db.staffSession.findUnique({ where: { id: sha(sid) } });
    const staff = s ? await ctx.db.staffUser.findUnique({ where: { id: s.staffId }, select: { clinicId: true } }) : null;
    return scopeOfClinic(ctx, staff?.clinicId);
  }
  return DEMO;
}
