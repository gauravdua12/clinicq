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
    await activateDemo(h.ctx, await clinicId(), null);
    expect(code(await patch(await login(iyer), await idOf(SEED.doctorPhone), { active: false }))).toBe("last_doctor");
  });

  it("a number that signs in to another clinic is never changed from here", async () => {
    await createCustomerClinic(h.ctx, { clinicName: "Sunrise Child Clinic", doctorName: "Dr. Mehta", doctorPhone: "9876500011", addressShort: "Baner, Pune", clinicPhone: "+91 20 4000 5555" }, null);
    const sid = await login(SEED.doctorPhone);
    expect(code(await add(sid, { name: "Hijack", phone: "9876500011", role: "STAFF" }))).toBe("phone_in_use");
    expect(await h.db.staffUser.findUniqueOrThrow({ where: { phoneHash: phoneHash("919876500011") } })).toMatchObject({ name: "Dr. Mehta", role: "DOCTOR" });
  });
});
