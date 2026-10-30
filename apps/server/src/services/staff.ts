import { normalizeIndianPhone, type StaffUser } from "@clinicq/db";
import type { Ctx } from "../context";
import { presenterPhones } from "./demo";

// A WhatsApp number signs in to one clinic. When someone changes clinics, the old clinic deactivates them (that releases
// the number) and the new clinic adds them: the same login moves over, signed out everywhere. A login that is still
// active never moves, and neither do Incolo's own logins (admins, demo presenters, the App Review login).

/** Incolo's own logins: they follow the server's config, never a clinic's Settings. */
export function isIncoloLogin(ctx: Ctx, wa: string): boolean {
  const listed = `${ctx.env.INCOLO_ADMIN_PHONES},${ctx.env.REVIEWER_PHONE}`.split(",").map((p) => normalizeIndianPhone(p)).filter(Boolean);
  return listed.includes(wa) || presenterPhones().includes(wa);
}

/** Moves a login its old clinic released into `clinicId`; false when it is still active there, or Incolo's own. */
export async function moveReleasedLogin(ctx: Ctx, existing: StaffUser, wa: string, clinicId: string, data: { name: string; role: "DOCTOR" | "STAFF" }): Promise<boolean> {
  if (existing.active || isIncoloLogin(ctx, wa)) return false;
  await ctx.db.staffSession.deleteMany({ where: { staffId: existing.id } }); // old sign-ins never carry over
  // Guarded on the state just read: if the old clinic reactivates them meanwhile, nothing moves.
  const r = await ctx.db.staffUser.updateMany({ where: { id: existing.id, clinicId: existing.clinicId, active: false }, data: { clinicId, ...data, active: true, onDuty: true } });
  return r.count === 1;
}
