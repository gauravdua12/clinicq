import { randomUUID, createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encrypt, phoneHash } from "@clinicq/db";
import { harness, SEED, type H } from "../harness";
import { createCustomerClinic } from "../../src/services/customers";
import { activateDemo, createDemo } from "../../src/services/demo";

// Settings → Staff can't lock a clinic out: nobody switches off or demotes their own login, an Incolo admin's login,
// or the clinic's last active doctor; and a number that signs in to another clinic is never touched from here.

let h: H;
const ADMIN = "919920323832";
beforeEach(async () => {
  h = await harness({ start: "2026-10-09T12:00:00+05:30" });
  h.ctx.env.INCOLO_ADMIN_PHONES = "9920323832";
});
afterEach(async () => h?.close());

async function login(phone: string): Promise<string> {
  const staff = await h.db.staffUser.findUniqueOrThrow({ where: { phoneHash: phoneHash(phone) } });
  const sid = randomUUID();
  await h.db.staffSession.create({ data: { id: createHash("sha256").update(sid).digest("hex"), staffId: staff.id, expiresAt: new Date("2030-01-01") } });
  return sid;
}
const idOf = async (phone: string) => (await h.db.staffUser.findUniqueOrThrow({ where: { phoneHash: phoneHash(phone) } })).id;
const patch = (sid: string, id: string, body: object) => h.app.inject({ method: "PATCH", url: `/api/settings/staff/${id}`, cookies: { sid }, payload: body });
const add = (sid: string, body: object) => h.app.inject({ method: "POST", url: "/api/settings/staff", cookies: { sid }, payload: body });
const code = (r: { json(): { error?: { code: string } } }) => r.json().error?.code;
const clinicId = async () => (await h.db.staffUser.findUniqueOrThrow({ where: { phoneHash: phoneHash(SEED.doctorPhone) } })).clinicId;

describe("Settings → Staff protects the logins a clinic can't do without", () => {
  it("you can't deactivate or demote yourself", async () => {
    const sid = await login(SEED.doctorPhone);
    expect(code(await patch(sid, await idOf(SEED.doctorPhone), { active: false }))).toBe("own_login");
    expect(code(await add(sid, { name: "Dr. Sharma", phone: SEED.doctorPhone, role: "STAFF" }))).toBe("own_login");
    expect((await h.db.staffUser.findUniqueOrThrow({ where: { phoneHash: phoneHash(SEED.doctorPhone) } }))).toMatchObject({ active: true, role: "DOCTOR" });
  });

  it("an Incolo admin's login can't be deactivated or demoted, even by another doctor", async () => {
    await h.db.staffUser.create({ data: { clinicId: await clinicId(), name: "Demo presenter", waPhone: encrypt(ADMIN), phoneHash: phoneHash(ADMIN), role: "DOCTOR" } });
    const sid = await login(SEED.doctorPhone);
    expect(code(await patch(sid, await idOf(ADMIN), { active: false }))).toBe("incolo_admin");
    expect(code(await add(sid, { name: "x", phone: "9920323832", role: "STAFF" }))).toBe("incolo_admin");
    const list = (await h.app.inject({ method: "GET", url: "/api/settings/staff", cookies: { sid } })).json() as { name: string; you: boolean; incoloAdmin: boolean }[];
    expect(list.find((r) => r.name === "Demo presenter")).toMatchObject({ incoloAdmin: true, you: false });
    expect(list.find((r) => r.name === "Dr. Sharma")).toMatchObject({ incoloAdmin: false, you: true });
  });

  it("another doctor can be switched off, staff always can, and the clinic's last active doctor stays", async () => {
    const other = "919811100777";
    await h.db.staffUser.create({ data: { clinicId: await clinicId(), name: "Dr. Mehta", waPhone: encrypt(other), phoneHash: phoneHash(other), role: "DOCTOR" } });
    const sid = await login(SEED.doctorPhone);
    expect((await patch(sid, await idOf(other), { active: false })).statusCode).toBe(200);
    expect((await patch(sid, await idOf(SEED.staffPhone), { active: false })).statusCode).toBe(200);
    expect((await patch(sid, await idOf(other), { active: true })).statusCode).toBe(200); // activating again is always fine
    // A doctor whose own clinic isn't the active demo clinic manages the active one: its only doctor stays.
    const { clinic } = await createDemo(h.ctx, { name: "Sanjeevani" }, null, { clinicName: "Sanjeevani", doctorName: "Dr. Iyer", sessions: [] } as never);
    const iyer = "919811100888";
    await h.db.staffUser.create({ data: { clinicId: clinic.id, name: "Dr. Iyer", waPhone: encrypt(iyer), phoneHash: phoneHash(iyer), role: "DOCTOR" } });
    await h.db.staffUser.update({ where: { phoneHash: phoneHash(other) }, data: { active: false } });
    h.ctx.env.INCOLO_ADMIN_PHONES = ""; // no Incolo admin login in the demo clinic either (theirs would count as a doctor)
    await activateDemo(h.ctx, await clinicId(), null);
    expect(code(await patch(await login(iyer), await idOf(SEED.doctorPhone), { active: false }))).toBe("last_doctor");
  });

  it("a number that signs in to another clinic is never changed from here", async () => {
    await createCustomerClinic(h.ctx, { clinicName: "Sunrise Child Clinic", doctorName: "Dr. Mehta", doctorPhone: "9876500011", addressShort: "Baner, Pune", clinicPhone: "+91 20 4000 5555" }, null);
    const sid = await login(SEED.doctorPhone);
    expect(code(await add(sid, { name: "Hijack", phone: "9876500011", role: "STAFF" }))).toBe("phone_in_use");
    expect(await h.db.staffUser.findUniqueOrThrow({ where: { phoneHash: phoneHash("919876500011") } })).toMatchObject({ name: "Dr. Mehta", role: "DOCTOR" });
  });

  it("someone changing clinics: once the old clinic deactivates them, the new clinic adds them and they move over", async () => {
    const { id: sunrise } = await createCustomerClinic(h.ctx, { clinicName: "Sunrise Child Clinic", doctorName: "Dr. Mehta", doctorPhone: "9876500011", addressShort: "Baner, Pune", clinicPhone: "+91 20 4000 5555" }, null);
    const sharma = await login(SEED.doctorPhone);
    const priyaSid = await login(SEED.staffPhone);
    expect(code(await add(sharma, { name: "Dr. Mehta", phone: "9876500011", role: "STAFF" }))).toBe("phone_in_use"); // still active at Sunrise
    // Priya leaves Dr. Sharma's clinic and joins Sunrise.
    expect((await patch(sharma, await idOf(SEED.staffPhone), { active: false })).statusCode).toBe(200);
    const mehta = await login("919876500011");
    const r = await h.app.inject({ method: "POST", url: "/api/settings/staff", cookies: { sid: mehta }, payload: { name: "Priya R", phone: SEED.staffPhone.slice(2), role: "STAFF" } });
    expect(r.json()).toMatchObject({ moved: true });
    expect(await h.db.staffUser.findUniqueOrThrow({ where: { phoneHash: phoneHash(SEED.staffPhone) } })).toMatchObject({ clinicId: sunrise, name: "Priya R", role: "STAFF", active: true });
    expect(await h.db.staffSession.count({ where: { staffId: await idOf(SEED.staffPhone) } })).toBe(0); // her old sign-in doesn't carry over
    expect((await h.app.inject({ method: "GET", url: "/api/me", cookies: { sid: priyaSid } })).statusCode).toBe(401);
    // She's gone from the old clinic's list, and the old clinic can't pull her back.
    const old = (await h.app.inject({ method: "GET", url: "/api/settings/staff", cookies: { sid: sharma } })).json() as { name: string }[];
    expect(old.map((x) => x.name)).not.toContain("Priya R");
    expect(code(await add(sharma, { name: "Priya", phone: SEED.staffPhone.slice(2), role: "STAFF" }))).toBe("phone_in_use");
  });

  it("Incolo's own logins never move to a clinic, even when switched off", async () => {
    await h.db.staffUser.create({ data: { clinicId: await clinicId(), name: "Demo presenter", waPhone: encrypt(ADMIN), phoneHash: phoneHash(ADMIN), role: "DOCTOR", active: false } });
    await expect(createCustomerClinic(h.ctx, { clinicName: "Sunrise Child Clinic", doctorName: "Dr. Mehta", doctorPhone: "9920323832", addressShort: "Baner, Pune", clinicPhone: "+91 20 4000 5555" }, null)).rejects.toThrow("phone_in_use");
  });

  it("a doctor whose old clinic released their number can get a clinic of their own", async () => {
    const other = "919811100777";
    await h.db.staffUser.create({ data: { clinicId: await clinicId(), name: "Dr. Mehta", waPhone: encrypt(other), phoneHash: phoneHash(other), role: "STAFF" } });
    await expect(createCustomerClinic(h.ctx, { clinicName: "Sunrise Child Clinic", doctorName: "Dr. Mehta", doctorPhone: "9811100777", addressShort: "Baner, Pune", clinicPhone: "+91 20 4000 5555" }, null)).rejects.toThrow("phone_in_use");
    await h.db.staffUser.update({ where: { phoneHash: phoneHash(other) }, data: { active: false } });
    const { id } = await createCustomerClinic(h.ctx, { clinicName: "Sunrise Child Clinic", doctorName: "Dr. Mehta", doctorPhone: "9811100777", addressShort: "Baner, Pune", clinicPhone: "+91 20 4000 5555" }, null);
    expect(await h.db.staffUser.findUniqueOrThrow({ where: { phoneHash: phoneHash(other) } })).toMatchObject({ clinicId: id, role: "DOCTOR", active: true });
  });

  it("Remove deletes a login for good, frees the number, and never removes a protected login", async () => {
    await h.db.staffUser.create({ data: { clinicId: await clinicId(), name: "Demo presenter", waPhone: encrypt(ADMIN), phoneHash: phoneHash(ADMIN), role: "DOCTOR" } });
    const sharma = await login(SEED.doctorPhone);
    const priya = await idOf(SEED.staffPhone);
    const priyaSid = await login(SEED.staffPhone);
    const del = (sid: string, id: string) => h.app.inject({ method: "DELETE", url: `/api/settings/staff/${id}`, cookies: { sid } });
    expect(code(await del(sharma, await idOf(SEED.doctorPhone)))).toBe("own_login");
    expect(code(await del(sharma, await idOf(ADMIN)))).toBe("incolo_admin");
    expect((await del(sharma, priya)).statusCode).toBe(200);
    expect(await h.db.staffUser.findUnique({ where: { id: priya } })).toBeNull();
    expect(await h.db.staffSession.count({ where: { staffId: priya } })).toBe(0);
    expect((await h.app.inject({ method: "GET", url: "/api/me", cookies: { sid: priyaSid } })).statusCode).toBe(401);
    expect(await h.db.auditLog.count({ where: { action: "staff.remove", entityId: priya } })).toBe(1);
    // The number is free: another clinic can add her as new staff.
    const { id: sunrise } = await createCustomerClinic(h.ctx, { clinicName: "Sunrise Child Clinic", doctorName: "Dr. Mehta", doctorPhone: "9876500011", addressShort: "Baner, Pune", clinicPhone: "+91 20 4000 5555" }, null);
    const r = await h.app.inject({ method: "POST", url: "/api/settings/staff", cookies: { sid: await login("919876500011") }, payload: { name: "Priya", phone: SEED.staffPhone.slice(2), role: "STAFF" } });
    expect(r.statusCode).toBe(200);
    expect(await h.db.staffUser.findUniqueOrThrow({ where: { phoneHash: phoneHash(SEED.staffPhone) } })).toMatchObject({ clinicId: sunrise, active: true });
    // A clinic can't remove another clinic's login, and the last active doctor stays (the same rule as Deactivate).
    expect((await del(sharma, await idOf("919876500011"))).statusCode).toBe(404);
    const iyer = await login("919876500011");
    expect(code(await del(iyer, await idOf("919876500011")))).toBe("own_login");
  });
});
