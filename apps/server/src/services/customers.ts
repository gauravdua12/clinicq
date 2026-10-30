import { randomBytes } from "node:crypto";
import { decrypt, encrypt, maskPhone, normalizeIndianPhone, phoneHash, type ClinicStatus } from "@clinicq/db";
import type { Ctx } from "../context";
import { invalidateClinicCache } from "./clinic";
import { uniqueCode } from "./demo";
import { audit } from "./notify";
import { isIncoloLogin, moveReleasedLogin } from "./staff";
import { disconnectWhatsApp } from "./embeddedSignup";
import { invalidateClinicStatus, invalidateNumberCache } from "./tenancy";
import { inScope } from "../scope";

// Customer clinics (docs/META_ONBOARDING.md §C): a clinic on its own WhatsApp number. Incolo creates it with the
// doctor's WhatsApp number; the doctor signs in, sets up hours, and connects the clinic's number (Embedded Signup).

export class CustomerError extends Error {
  constructor(public code: "bad_phone" | "phone_in_use" | "not_found" | "confirm_name") { super(code); }
}

export interface CustomerInput { clinicName: string; doctorName: string; doctorPhone: string; addressShort: string; clinicPhone: string }

export async function createCustomerClinic(ctx: Ctx, input: CustomerInput, actorId: string | null): Promise<{ id: string; code: string }> {
  const wa = normalizeIndianPhone(input.doctorPhone);
  if (!wa) throw new CustomerError("bad_phone");
  // A doctor whose number another clinic has released (deactivated) brings that login over; an active one never moves.
  const existing = await ctx.db.staffUser.findUnique({ where: { phoneHash: phoneHash(wa) } });
  if (existing && (existing.active || (await isIncoloLogin(ctx, wa)))) throw new CustomerError("phone_in_use");
  const clinic = await ctx.db.clinic.create({
    data: {
      name: input.clinicName, addressShort: input.addressShort, addressFull: input.addressShort, phone: input.clinicPhone,
      code: await uniqueCode(ctx, input.clinicName), noticeUrl: `${ctx.env.PUBLIC_BASE_URL}${ctx.env.BASE_PATH}/privacy`,
      grievanceContact: { name: input.doctorName, email: "", phone: input.clinicPhone }, settings: {},
      displayKey: randomBytes(18).toString("base64url"), ownNumber: true,
    },
  });
  const doctor = await ctx.db.doctor.create({ data: { clinicId: clinic.id, displayName: input.doctorName } });
  // Usual Indian clinic hours to start with (Mon–Sat mornings and evenings); the doctor adjusts them in Settings.
  for (let wd = 1; wd <= 6; wd++) {
    await ctx.db.session.create({ data: { doctorId: doctor.id, weekday: wd, label: "Morning", startTime: "10:00", endTime: "13:00", slotMinutes: 15, walkinQuota: 10 } });
    await ctx.db.session.create({ data: { doctorId: doctor.id, weekday: wd, label: "Evening", startTime: "17:00", endTime: "20:00", slotMinutes: 15, walkinQuota: 10 } });
  }
  if (existing) await moveReleasedLogin(ctx, existing, wa, clinic.id, { name: input.doctorName, role: "DOCTOR" });
  else await ctx.db.staffUser.create({ data: { clinicId: clinic.id, name: input.doctorName, waPhone: encrypt(wa), phoneHash: phoneHash(wa), role: "DOCTOR" } });
  invalidateClinicCache();
  await audit(ctx, "OPERATOR", actorId, "customer.create", "Clinic", clinic.id, { name: clinic.name });
  return { id: clinic.id, code: clinic.code };
}

export interface CustomerView {
  id: string; name: string; code: string; doctor: string; doctorPhone: string; createdAt: string; status: ClinicStatus; statusChangedAt: string | null; logins: number;
  whatsapp: { status: string; displayPhone: string | null; verifiedName: string | null } | null;
}

/** Every customer clinic, for the admin portal: who runs it and its number. Never its patients. */
export async function listCustomerClinics(ctx: Ctx): Promise<CustomerView[]> {
  const rows = await ctx.db.clinic.findMany({ where: { ownNumber: true }, orderBy: { createdAt: "desc" }, include: { doctors: true, waConnection: true, staff: { select: { role: true, active: true, waPhone: true } } } });
  return rows.map((c) => {
    const doc = c.staff.find((s) => s.role === "DOCTOR" && s.active) ?? c.staff.find((s) => s.role === "DOCTOR");
    return {
      id: c.id, name: c.name, code: c.code, doctor: c.doctors[0]?.displayName ?? "", doctorPhone: doc ? maskPhone(decrypt(doc.waPhone)) : "",
      createdAt: c.createdAt.toISOString(), status: c.status, statusChangedAt: c.statusChangedAt?.toISOString() ?? null, logins: c.staff.filter((s) => s.active).length,
      whatsapp: c.waConnection ? { status: c.waConnection.status, displayPhone: c.waConnection.displayPhone, verifiedName: c.waConnection.verifiedName } : null,
    };
  });
}

export async function customerClinic(ctx: Ctx, id: string): Promise<CustomerView & { addressShort: string; phone: string; whatsappDetail: { connectedBy: string | null; connectedAt: string; checkedAt: string | null } | null }> {
  const c = await ctx.db.clinic.findFirst({ where: { id, ownNumber: true }, include: { waConnection: true } });
  if (!c) throw new CustomerError("not_found");
  const view = (await listCustomerClinics(ctx)).find((v) => v.id === id)!;
  const w = c.waConnection;
  return { ...view, addressShort: c.addressShort, phone: c.phone, whatsappDetail: w ? { connectedBy: w.connectedBy, connectedAt: w.connectedAt.toISOString(), checkedAt: w.checkedAt?.toISOString() ?? null } : null };
}

/**
 * ACTIVE ⇄ SUSPENDED ⇄ ARCHIVED (customer clinics). Suspended: its logins are signed out and can't sign in, the bot
 * doesn't answer on its number, and nothing is sent (reminders due meanwhile are dropped). Archived (a clinic that
 * left): the same, plus its WhatsApp number is disconnected from Q-Incolo so they can use it elsewhere. Its data is
 * kept; reactivating brings it back (an archived clinic's doctor connects the number again).
 */
export async function setClinicStatus(ctx: Ctx, id: string, status: ClinicStatus, actorId: string): Promise<void> {
  const c = await ctx.db.clinic.findFirst({ where: { id, ownNumber: true } });
  if (!c) throw new CustomerError("not_found");
  if (c.status === status) return;
  if (status === "ARCHIVED") await inScope({ clinicId: id }, () => disconnectWhatsApp(ctx, actorId));
  await ctx.db.clinic.update({ where: { id }, data: { status, statusChangedAt: ctx.clock.now() } });
  if (status !== "ACTIVE") {
    const staff = await ctx.db.staffUser.findMany({ where: { clinicId: id }, select: { id: true } });
    await ctx.db.staffSession.deleteMany({ where: { staffId: { in: staff.map((s) => s.id) } } });
  }
  clinicStatusChanged(ctx, id);
  await audit(ctx, "INCOLO", actorId, `clinic.${status.toLowerCase()}`, "Clinic", id, { from: c.status });
}

/** Delete a customer clinic for good: its patients, bookings, queue, logins, number and settings. */
export async function deleteCustomerClinic(ctx: Ctx, id: string, confirmName: string, actorId: string): Promise<void> {
  const c = await ctx.db.clinic.findFirst({ where: { id, ownNumber: true } });
  if (!c) throw new CustomerError("not_found");
  if (confirmName.trim() !== c.name.trim()) throw new CustomerError("confirm_name");
  await inScope({ clinicId: id }, () => disconnectWhatsApp(ctx, actorId));
  const doctorIds = (await ctx.db.doctor.findMany({ where: { clinicId: id }, select: { id: true } })).map((d) => d.id);
  const accountIds = (await ctx.db.patientAccount.findMany({ where: { channel: id }, select: { id: true } })).map((a) => a.id);
  const staffIds = (await ctx.db.staffUser.findMany({ where: { clinicId: id }, select: { id: true, phoneHash: true } }));
  const apptIds = (await ctx.db.appointment.findMany({ where: { doctorId: { in: doctorIds } }, select: { id: true } })).map((a) => a.id);
  const byDoctor = { where: { doctorId: { in: doctorIds } } };
  await ctx.db.$transaction([
    ctx.db.$executeRaw`DELETE FROM "ScheduledJob" WHERE "doneAt" IS NULL AND data->>'clinicScope' = ${id}`,
    ctx.db.queueEntry.deleteMany(byDoctor),
    ctx.db.payment.deleteMany({ where: { appointmentId: { in: apptIds } } }),
    ctx.db.appointment.deleteMany(byDoctor),
    ctx.db.walkinOverflowRequest.deleteMany(byDoctor),
    ctx.db.tokenCounter.deleteMany(byDoctor),
    ctx.db.closure.deleteMany(byDoctor),
    ctx.db.blockedSlot.deleteMany(byDoctor),
    ctx.db.followUp.deleteMany(byDoctor),
    ctx.db.paymentDue.deleteMany(byDoctor),
    ctx.db.session.deleteMany(byDoctor),
    ctx.db.doctor.deleteMany({ where: { clinicId: id } }),
    ctx.db.conversationState.deleteMany({ where: { accountId: { in: [...accountIds, ...staffIds.map((s) => `staff:${s.id}`)] } } }),
    ctx.db.flowToken.deleteMany({ where: { accountId: { in: accountIds } } }),
    ctx.db.messageLog.deleteMany({ where: { accountId: { in: accountIds } } }),
    ctx.db.patientAccount.deleteMany({ where: { channel: id } }), // profiles and consents go with it
    ctx.db.staffSession.deleteMany({ where: { staffId: { in: staffIds.map((s) => s.id) } } }),
    ctx.db.otpChallenge.deleteMany({ where: { phoneHash: { in: staffIds.map((s) => s.phoneHash) } } }),
    ctx.db.staffUser.deleteMany({ where: { clinicId: id } }),
    ctx.db.dailyWalkinCode.deleteMany({ where: { clinicId: id } }),
    ctx.db.clinic.delete({ where: { id } }), // its WhatsApp connection record goes with it
  ]);
  clinicStatusChanged(ctx, id);
  invalidateClinicCache();
  await audit(ctx, "INCOLO", actorId, "clinic.delete", "Clinic", id, { name: c.name });
}

function clinicStatusChanged(ctx: Ctx, id: string): void {
  invalidateClinicStatus();
  invalidateNumberCache();
  ctx.wa.invalidate(id);
}
