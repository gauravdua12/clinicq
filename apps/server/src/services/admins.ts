import { decrypt, encrypt, maskPhone, normalizeIndianPhone, phoneHash, type StaffUser } from "@clinicq/db";
import type { Ctx } from "../context";
import { clinicInfo } from "./clinic";
import { audit } from "./notify";
import { inScope } from "../scope";

// Incolo's own admins: the admin portal (clinics, logins on a clinic's behalf, Demo Studio, language model, admins).
// Owners are the numbers in INCOLO_ADMIN_PHONES (server config): always admins, never removable from the portal.
// More admins are added in the portal. Every active admin also has a doctor login in the shared-number (demo) clinic,
// which is how they sign in, and how they show the clinic side in a demo. They never see a customer clinic's patients.

export class AdminError extends Error {
  constructor(public code: "bad_phone" | "phone_in_use" | "own_login" | "owner" | "not_found") { super(code); }
}

const ownerPhones = (ctx: Ctx) => ctx.env.INCOLO_ADMIN_PHONES.split(",").map((p) => normalizeIndianPhone(p)).filter((p): p is string => !!p);

/** An Incolo admin's number (owner, or an active admin added in the portal). */
export async function isAdminPhone(ctx: Ctx, wa: string): Promise<boolean> {
  if (ownerPhones(ctx).includes(wa)) return true;
  return !!(await ctx.db.incoloAdmin.findFirst({ where: { phoneHash: phoneHash(wa), active: true }, select: { id: true } }));
}

export async function isIncoloAdmin(ctx: Ctx, staff: StaffUser): Promise<boolean> {
  return isAdminPhone(ctx, decrypt(staff.waPhone));
}

/** Any number Incolo has made an admin (even switched off): such a login never belongs to a customer clinic. */
export async function isAdminRecord(ctx: Ctx, wa: string): Promise<boolean> {
  return ownerPhones(ctx).includes(wa) || !!(await ctx.db.incoloAdmin.findUnique({ where: { phoneHash: phoneHash(wa) }, select: { id: true } }));
}

/** Phones of every active admin (demo presenters follow the active demo clinic). */
export async function adminPhones(ctx: Ctx): Promise<string[]> {
  const rows = await ctx.db.incoloAdmin.findMany({ where: { active: true }, select: { waPhone: true } });
  return [...new Set([...ownerPhones(ctx), ...rows.map((r) => decrypt(r.waPhone))])];
}

/** The admin's login in the shared-number clinic (created, or switched back on). A customer clinic's login is left alone. */
async function ensureLogin(ctx: Ctx, wa: string, name: string): Promise<void> {
  const { clinic } = await inScope({ clinicId: null }, () => clinicInfo(ctx));
  const existing = await ctx.db.staffUser.findUnique({ where: { phoneHash: phoneHash(wa) }, include: { clinic: { select: { ownNumber: true } } } });
  if (existing?.clinic.ownNumber) return;
  if (existing) await ctx.db.staffUser.update({ where: { id: existing.id }, data: { active: true, role: "DOCTOR" } });
  else await ctx.db.staffUser.create({ data: { clinicId: clinic.id, name, waPhone: encrypt(wa), phoneHash: phoneHash(wa), role: "DOCTOR" } });
}

async function endLogin(ctx: Ctx, wa: string, remove: boolean): Promise<void> {
  const s = await ctx.db.staffUser.findUnique({ where: { phoneHash: phoneHash(wa) }, include: { clinic: { select: { ownNumber: true } } } });
  if (!s || s.clinic.ownNumber) return;
  await ctx.db.staffSession.deleteMany({ where: { staffId: s.id } });
  await ctx.db.otpChallenge.deleteMany({ where: { phoneHash: s.phoneHash } });
  if (remove) await ctx.db.staffUser.delete({ where: { id: s.id } });
  else await ctx.db.staffUser.update({ where: { id: s.id }, data: { active: false } });
}

/** At boot: owners from the server config are admins, and every active admin can sign in. */
export async function ensureAdmins(ctx: Ctx): Promise<void> {
  for (const wa of ownerPhones(ctx)) {
    await ctx.db.incoloAdmin.upsert({ where: { phoneHash: phoneHash(wa) }, create: { name: "Incolo admin", waPhone: encrypt(wa), phoneHash: phoneHash(wa), owner: true }, update: { owner: true, active: true } });
  }
  for (const a of await ctx.db.incoloAdmin.findMany({ where: { active: true } })) await ensureLogin(ctx, decrypt(a.waPhone), a.name);
}

export interface AdminView { id: string; name: string; phone: string; owner: boolean; active: boolean; you: boolean; createdAt: string }

export async function listAdmins(ctx: Ctx, viewer: StaffUser): Promise<AdminView[]> {
  const rows = await ctx.db.incoloAdmin.findMany({ orderBy: [{ owner: "desc" }, { createdAt: "asc" }] });
  return rows.map((r) => ({ id: r.id, name: r.name, phone: maskPhone(decrypt(r.waPhone)), owner: r.owner || ownerPhones(ctx).includes(decrypt(r.waPhone)), active: r.active, you: r.phoneHash === viewer.phoneHash, createdAt: r.createdAt.toISOString() }));
}

export async function addAdmin(ctx: Ctx, actor: StaffUser, input: { name: string; phone: string }): Promise<{ id: string }> {
  const wa = normalizeIndianPhone(input.phone);
  if (!wa) throw new AdminError("bad_phone");
  // A number that signs in to a customer clinic stays that clinic's: Incolo admins use their own numbers.
  const login = await ctx.db.staffUser.findUnique({ where: { phoneHash: phoneHash(wa) }, include: { clinic: { select: { ownNumber: true } } } });
  if (login?.clinic.ownNumber) throw new AdminError("phone_in_use");
  const a = await ctx.db.incoloAdmin.upsert({ where: { phoneHash: phoneHash(wa) }, create: { name: input.name, waPhone: encrypt(wa), phoneHash: phoneHash(wa), addedById: actor.id }, update: { name: input.name, active: true } });
  await ensureLogin(ctx, wa, input.name);
  await audit(ctx, "INCOLO", actor.id, "admin.add", "IncoloAdmin", a.id);
  return { id: a.id };
}

async function target(ctx: Ctx, actor: StaffUser, id: string) {
  const a = await ctx.db.incoloAdmin.findUnique({ where: { id } });
  if (!a) throw new AdminError("not_found");
  if (a.phoneHash === actor.phoneHash) throw new AdminError("own_login");
  if (a.owner || ownerPhones(ctx).includes(decrypt(a.waPhone))) throw new AdminError("owner");
  return a;
}

export async function setAdminActive(ctx: Ctx, actor: StaffUser, id: string, active: boolean): Promise<void> {
  const a = active ? await ctx.db.incoloAdmin.findUnique({ where: { id } }) : await target(ctx, actor, id);
  if (!a) throw new AdminError("not_found");
  await ctx.db.incoloAdmin.update({ where: { id }, data: { active } });
  if (active) await ensureLogin(ctx, decrypt(a.waPhone), a.name); else await endLogin(ctx, decrypt(a.waPhone), false);
  await audit(ctx, "INCOLO", actor.id, active ? "admin.activate" : "admin.deactivate", "IncoloAdmin", id);
}

export async function removeAdmin(ctx: Ctx, actor: StaffUser, id: string): Promise<void> {
  const a = await target(ctx, actor, id);
  await endLogin(ctx, decrypt(a.waPhone), true);
  await ctx.db.incoloAdmin.delete({ where: { id } });
  await audit(ctx, "INCOLO", actor.id, "admin.remove", "IncoloAdmin", id);
}
