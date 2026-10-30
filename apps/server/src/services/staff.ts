import { decrypt, encrypt, maskPhone, normalizeIndianPhone, phoneHash, type StaffRole, type StaffUser } from "@clinicq/db";
import type { Ctx } from "../context";
import { isAdminPhone, isAdminRecord } from "./admins";
import { presenterPhones } from "./demo";
import { audit } from "./notify";

// A clinic's logins (Settings → Staff, and the admin portal on a clinic's behalf).
//
// Roles: DOCTOR and CLINIC_ADMIN manage the clinic; a clinic admin works on the doctor's behalf but never adds, changes
// or removes a doctor's login. STAFF run the desk. An Incolo admin can manage any clinic's logins when the clinic
// can't. Nobody can lock a clinic out: your own login, Incolo's logins, and the clinic's last active doctor can't be
// deactivated, removed or demoted.
//
// A WhatsApp number signs in to one clinic. When someone changes clinics, the old clinic deactivates or removes them
// (that releases the number) and the new clinic adds them: the same login moves over, signed out everywhere. A login
// that is still active never moves, and neither do Incolo's own logins (admins, demo presenters, the App Review login).

export class StaffError extends Error {
  constructor(public code: "bad_request" | "not_found" | "own_login" | "incolo_admin" | "last_doctor" | "doctor_only" | "phone_in_use") { super(code); }
}

/** Who is making the change: a manager of this clinic, or an Incolo admin acting for it. */
export interface Actor { staff: StaffUser; incolo: boolean }

export const isManager = (s: { role: StaffRole }) => s.role === "DOCTOR" || s.role === "CLINIC_ADMIN";

/** Incolo's own logins: they follow the server's config and the admin portal, never a clinic's Settings. */
export async function isIncoloLogin(ctx: Ctx, wa: string): Promise<boolean> {
  const reviewer = normalizeIndianPhone(ctx.env.REVIEWER_PHONE);
  return wa === reviewer || presenterPhones().includes(wa) || (await isAdminRecord(ctx, wa));
}

export interface LoginView { id: string; name: string; role: StaffRole; onDuty: boolean; active: boolean; phone: string; you: boolean; incoloAdmin: boolean }

export async function listLogins(ctx: Ctx, clinicId: string, viewer: StaffUser): Promise<LoginView[]> {
  const rows = await ctx.db.staffUser.findMany({ where: { clinicId }, orderBy: [{ role: "asc" }, { name: "asc" }] });
  return Promise.all(rows.map(async (r) => {
    const wa = decrypt(r.waPhone);
    return { id: r.id, name: r.name, role: r.role, onDuty: r.onDuty, active: r.active, phone: maskPhone(wa), you: r.id === viewer.id, incoloAdmin: await isAdminPhone(ctx, wa) };
  }));
}

/** Why a change to a login is refused, or null. `remove` = deleting it. */
async function refusal(ctx: Ctx, actor: Actor, target: StaffUser, change: { active?: boolean; role?: StaffRole; remove?: boolean }): Promise<StaffError["code"] | null> {
  const switchesOff = change.remove || (change.active === false && target.active);
  const roleChange = change.role !== undefined && change.role !== target.role;
  if (!switchesOff && !roleChange) return null;
  if (target.id === actor.staff.id) return "own_login";
  if (await isIncoloLogin(ctx, decrypt(target.waPhone))) return "incolo_admin";
  if (!actor.incolo && actor.staff.role === "CLINIC_ADMIN" && (target.role === "DOCTOR" || change.role === "DOCTOR")) return "doctor_only";
  const losesDoctor = target.role === "DOCTOR" && target.active && (switchesOff || roleChange);
  if (losesDoctor) {
    const others = await ctx.db.staffUser.count({ where: { clinicId: target.clinicId, role: "DOCTOR", active: true, id: { not: target.id } } });
    if (!others) return "last_doctor";
  }
  return null;
}

/** Moves a login its old clinic released into `clinicId`; false when it is still active there, or Incolo's own. */
export async function moveReleasedLogin(ctx: Ctx, existing: StaffUser, wa: string, clinicId: string, data: { name: string; role: StaffRole }): Promise<boolean> {
  if (existing.active || (await isIncoloLogin(ctx, wa))) return false;
  await ctx.db.staffSession.deleteMany({ where: { staffId: existing.id } }); // old sign-ins never carry over
  // Guarded on the state just read: if the old clinic reactivates them meanwhile, nothing moves.
  const r = await ctx.db.staffUser.updateMany({ where: { id: existing.id, clinicId: existing.clinicId, active: false }, data: { clinicId, ...data, active: true, onDuty: true } });
  return r.count === 1;
}

const actorType = (a: Actor) => (a.incolo ? "INCOLO" : a.staff.role);

/** Add someone (or update a login already in this clinic, or move one another clinic released). */
export async function addLogin(ctx: Ctx, clinicId: string, actor: Actor, input: { name: string; phone: string; role: StaffRole }): Promise<{ id: string; moved?: true }> {
  const wa = normalizeIndianPhone(input.phone);
  if (!wa || !input.name.trim()) throw new StaffError("bad_request");
  if (!actor.incolo && actor.staff.role === "CLINIC_ADMIN" && input.role === "DOCTOR") throw new StaffError("doctor_only");
  const existing = await ctx.db.staffUser.findUnique({ where: { phoneHash: phoneHash(wa) } });
  if (existing && existing.clinicId !== clinicId) { // another clinic's login: moves here only once that clinic has released it
    if (!(await moveReleasedLogin(ctx, existing, wa, clinicId, { name: input.name, role: input.role }))) throw new StaffError("phone_in_use");
    await audit(ctx, actorType(actor), actor.staff.id, "staff.move_in", "StaffUser", existing.id);
    return { id: existing.id, moved: true };
  }
  if (existing) {
    const refused = await refusal(ctx, actor, existing, { role: input.role });
    if (refused) throw new StaffError(refused);
  } else if (await isIncoloLogin(ctx, wa)) throw new StaffError("phone_in_use");
  const u = await ctx.db.staffUser.upsert({ where: { phoneHash: phoneHash(wa) }, create: { clinicId, name: input.name, waPhone: encrypt(wa), phoneHash: phoneHash(wa), role: input.role }, update: { name: input.name, role: input.role, active: true } });
  await audit(ctx, actorType(actor), actor.staff.id, "staff.upsert", "StaffUser", u.id, { role: input.role });
  return { id: u.id };
}

async function loginIn(ctx: Ctx, clinicId: string, id: string): Promise<StaffUser> {
  const t = await ctx.db.staffUser.findUnique({ where: { id } });
  if (!t || t.clinicId !== clinicId) throw new StaffError("not_found");
  return t;
}

export async function updateLogin(ctx: Ctx, clinicId: string, actor: Actor, id: string, change: { onDuty?: boolean; active?: boolean; role?: StaffRole }): Promise<void> {
  const target = await loginIn(ctx, clinicId, id);
  const refused = await refusal(ctx, actor, target, change);
  if (refused) throw new StaffError(refused);
  if (change.active === false) await ctx.db.staffSession.deleteMany({ where: { staffId: id } });
  await ctx.db.staffUser.update({ where: { id }, data: change });
  await audit(ctx, actorType(actor), actor.staff.id, "staff.update", "StaffUser", id, change);
}

/** Remove: the login is deleted for good (sign-ins and any pending code too), which frees the number for any clinic. */
export async function removeLogin(ctx: Ctx, clinicId: string, actor: Actor, id: string): Promise<void> {
  const target = await loginIn(ctx, clinicId, id);
  const refused = await refusal(ctx, actor, target, { remove: true });
  if (refused) throw new StaffError(refused);
  await ctx.db.staffSession.deleteMany({ where: { staffId: id } });
  await ctx.db.otpChallenge.deleteMany({ where: { phoneHash: target.phoneHash } });
  await ctx.db.staffUser.deleteMany({ where: { id, clinicId } });
  await audit(ctx, actorType(actor), actor.staff.id, "staff.remove", "StaffUser", id);
}
