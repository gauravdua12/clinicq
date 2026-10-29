import { randomBytes } from "node:crypto";
import { decrypt, encrypt, maskPhone, normalizeIndianPhone, phoneHash } from "@clinicq/db";
import type { Ctx } from "../context";
import { invalidateClinicCache } from "./clinic";
import { uniqueCode } from "./demo";
import { audit } from "./notify";

// Customer clinics (docs/META_ONBOARDING.md §C): a clinic on its own WhatsApp number. Incolo creates it with the
// doctor's WhatsApp number; the doctor signs in, sets up hours, and connects the clinic's number (Embedded Signup).

export class CustomerError extends Error {
  constructor(public code: "bad_phone" | "phone_in_use") { super(code); }
}

export interface CustomerInput { clinicName: string; doctorName: string; doctorPhone: string; addressShort: string; clinicPhone: string }

export async function createCustomerClinic(ctx: Ctx, input: CustomerInput, actorId: string | null): Promise<{ id: string; code: string }> {
  const wa = normalizeIndianPhone(input.doctorPhone);
  if (!wa) throw new CustomerError("bad_phone");
  if (await ctx.db.staffUser.findUnique({ where: { phoneHash: phoneHash(wa) } })) throw new CustomerError("phone_in_use");
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
  await ctx.db.staffUser.create({ data: { clinicId: clinic.id, name: input.doctorName, waPhone: encrypt(wa), phoneHash: phoneHash(wa), role: "DOCTOR" } });
  invalidateClinicCache();
  await audit(ctx, "OPERATOR", actorId, "customer.create", "Clinic", clinic.id, { name: clinic.name });
  return { id: clinic.id, code: clinic.code };
}

export interface CustomerView { id: string; name: string; doctor: string; doctorPhone: string; createdAt: string; whatsapp: { status: string; displayPhone: string | null; verifiedName: string | null } | null }

export async function listCustomerClinics(ctx: Ctx): Promise<CustomerView[]> {
  const rows = await ctx.db.clinic.findMany({ where: { ownNumber: true }, orderBy: { createdAt: "desc" }, include: { doctors: true, waConnection: true, staff: { where: { role: "DOCTOR" }, take: 1 } } });
  return rows.map((c) => ({
    id: c.id, name: c.name, doctor: c.doctors[0]?.displayName ?? "", doctorPhone: c.staff[0] ? maskPhone(decrypt(c.staff[0].waPhone)) : "",
    createdAt: c.createdAt.toISOString(),
    whatsapp: c.waConnection ? { status: c.waConnection.status, displayPhone: c.waConnection.displayPhone, verifiedName: c.waConnection.verifiedName } : null,
  }));
}
