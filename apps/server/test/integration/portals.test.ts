import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { phoneHash } from "@clinicq/db";
import { buildWebhook, signBody } from "@clinicq/wa";
import { harness, SEED, type H } from "../harness";
import { createCustomerClinic } from "../../src/services/customers";
import { setGraphFetch } from "../../src/services/embeddedSignup";
import { invalidateClinicStatus, invalidateNumberCache } from "../../src/services/tenancy";

// Two portals: Incolo's admin portal (clinics, logins on a clinic's behalf, admins, demo, language model) and a
// clinic's own portal (its doctor, clinic admins and staff). Neither reaches into the other; admins never see a
// customer clinic's patients.

let h: H;
const WABA = "1098765432100";
const PNID = "1234567890123";
const DOC = "919876500011";
let sunrise = "";

function fakeGraph(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname.replace(/^\/v[\d.]+\//, "");
    const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json" } });
    if (path === "oauth/access_token") return ok({ access_token: "EAAclinic-business-token" });
    if (path === `${WABA}/phone_numbers`) return ok({ data: [{ id: PNID, display_phone_number: "+91 98111 22333", verified_name: "Sunrise Child Clinic" }] });
    return ok({ success: true, data: [] });
  }) as typeof fetch;
}

beforeEach(async () => {
  process.env.META_APP_ID = "2655971144875702";
  process.env.META_ES_CONFIG_ID = "1454298736672568";
  h = await harness({ start: "2026-10-09T12:00:00+05:30" });
  invalidateNumberCache(); invalidateClinicStatus(); h.ctx.wa.invalidate();
  setGraphFetch(fakeGraph());
  sunrise = (await createCustomerClinic(h.ctx, { clinicName: "Sunrise Child Clinic", doctorName: "Dr. Mehta", doctorPhone: DOC, addressShort: "Baner, Pune", clinicPhone: "+91 20 4000 5555" }, null)).id;
});
afterEach(async () => { setGraphFetch(null); delete process.env.META_APP_ID; delete process.env.META_ES_CONFIG_ID; await h?.close(); });

async function sidFor(phone: string): Promise<string> {
  const staff = await h.db.staffUser.findUniqueOrThrow({ where: { phoneHash: phoneHash(phone) } });
  const sid = randomUUID();
  await h.db.staffSession.create({ data: { id: createHash("sha256").update(sid).digest("hex"), staffId: staff.id, expiresAt: new Date("2030-01-01") } });
  return sid;
}
const api = (sid: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) => h.app.inject({ method, url, cookies: { sid }, ...(payload ? { payload } : {}) });
const code = (r: { json(): { error?: { code: string } } }) => r.json().error?.code;
const incolo = async () => (await h.app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { role: "INCOLO" } })).cookies.find((c) => c.name === "sid")!.value;
const idOf = async (phone: string) => (await h.db.staffUser.findUniqueOrThrow({ where: { phoneHash: phoneHash(phone) } })).id;
const webhookHi = (from: string) => {
  const payload = JSON.stringify(buildWebhook({ from, wamid: `wamid.t.${randomUUID()}`, message: { type: "text", text: { body: "Hi" } }, phoneNumberId: PNID }));
  return h.app.inject({ method: "POST", url: "/webhook", headers: { "content-type": "application/json", "x-hub-signature-256": signBody(payload, h.ctx.env.META_APP_SECRET) }, payload });
};

describe("who reaches which portal", () => {
  it("a clinic's doctor manages their clinic, never Incolo's pages; an Incolo admin has the admin portal", async () => {
    const doc = await sidFor(DOC);
    expect((await api(doc, "GET", "/api/me")).json()).toMatchObject({ role: "DOCTOR", incoloAdmin: false });
    for (const url of ["/api/admin/clinics", `/api/admin/clinics/${sunrise}`, "/api/admin/admins", "/api/admin/ai"]) expect((await api(doc, "GET", url)).statusCode).toBe(403);
    expect((await api(doc, "GET", "/api/settings/sessions")).statusCode).toBe(200);
    const admin = await incolo();
    expect((await api(admin, "GET", "/api/me")).json()).toMatchObject({ incoloAdmin: true });
    for (const url of ["/api/admin/clinics", "/api/admin/admins", "/api/admin/ai"]) expect((await api(admin, "GET", url)).statusCode).toBe(200);
    // the clinic's page in the admin portal: who runs it and its logins, never its patients
    const detail = (await api(admin, "GET", `/api/admin/clinics/${sunrise}`)).json() as Record<string, unknown> & { staff: { name: string; phone: string }[] };
    expect(detail).toMatchObject({ name: "Sunrise Child Clinic", status: "ACTIVE", doctor: "Dr. Mehta" });
    expect(detail.staff.map((s) => s.name)).toEqual(["Dr. Mehta"]);
    expect(detail.staff[0]!.phone).toMatch(/x/); // masked
    expect(Object.keys(detail)).not.toEqual(expect.arrayContaining(["appointments", "patients", "queue"]));
    // a demo clinic isn't managed from Clinics
    expect((await api(admin, "GET", `/api/admin/clinics/${(await h.db.staffUser.findUniqueOrThrow({ where: { phoneHash: phoneHash(SEED.doctorPhone) } })).clinicId}`)).statusCode).toBe(404);
  });

  it("a clinic admin works on the doctor's behalf, except doctor logins; staff can't open Settings", async () => {
    const doc = await sidFor(DOC);
    expect((await api(doc, "POST", "/api/settings/staff", { name: "Kavita", phone: "9876500022", role: "CLINIC_ADMIN" })).statusCode).toBe(200);
    expect((await api(doc, "POST", "/api/settings/staff", { name: "Ravi", phone: "9876500033", role: "STAFF" })).statusCode).toBe(200);
    const kavita = await sidFor("919876500022");
    expect((await api(kavita, "GET", "/api/settings/sessions")).statusCode).toBe(200);
    expect((await api(kavita, "GET", "/api/settings/clinic")).statusCode).toBe(200);
    expect((await api(kavita, "GET", "/api/whatsapp")).statusCode).toBe(200);
    expect((await api(kavita, "GET", "/api/reports/summary?from=2026-10-01&to=2026-10-09")).statusCode).toBe(200);
    expect((await api(kavita, "POST", "/api/settings/staff", { name: "Asha", phone: "9876500044", role: "STAFF" })).statusCode).toBe(200);
    expect((await api(kavita, "PATCH", `/api/settings/staff/${await idOf("919876500033")}`, { role: "CLINIC_ADMIN" })).statusCode).toBe(200);
    // never a doctor's login
    expect(code(await api(kavita, "POST", "/api/settings/staff", { name: "Dr. New", phone: "9876500055", role: "DOCTOR" }))).toBe("doctor_only");
    expect(code(await api(kavita, "PATCH", `/api/settings/staff/${await idOf(DOC)}`, { active: false }))).toBe("doctor_only");
    expect(code(await api(kavita, "DELETE", `/api/settings/staff/${await idOf(DOC)}`))).toBe("doctor_only");
    expect(code(await api(kavita, "PATCH", `/api/settings/staff/${await idOf("919876500044")}`, { role: "DOCTOR" }))).toBe("doctor_only");
    // the doctor can promote someone to doctor
    expect((await api(doc, "PATCH", `/api/settings/staff/${await idOf("919876500044")}`, { role: "DOCTOR" })).statusCode).toBe(200);
    const asha = await sidFor("919876500044");
    expect((await api(asha, "GET", "/api/me")).json()).toMatchObject({ role: "DOCTOR" });
    // staff run the desk only
    const staff = await sidFor("919876500033");
    await api(doc, "PATCH", `/api/settings/staff/${await idOf("919876500033")}`, { role: "STAFF" });
    expect((await api(staff, "GET", "/api/queue/today")).statusCode).toBe(200);
    expect((await api(staff, "GET", "/api/settings/sessions")).statusCode).toBe(403);
    expect((await api(staff, "GET", "/api/settings/staff")).statusCode).toBe(403);
  });
});

describe("Incolo admins", () => {
  it("add, sign in, switch off and remove admins; owners and your own login stay", async () => {
    h.ctx.env.INCOLO_ADMIN_PHONES = "9920323832";
    const { ensureAdmins } = await import("../../src/services/admins");
    await ensureAdmins(h.ctx);
    const owner = await sidFor("919920323832");
    expect((await api(owner, "POST", "/api/admin/admins", { name: "Neeraj", phone: "98111 00001" })).statusCode).toBe(200);
    const neeraj = await sidFor("919811100001"); // their sign-in login exists now
    expect((await api(neeraj, "GET", "/api/admin/clinics")).statusCode).toBe(200);
    const list = (await api(owner, "GET", "/api/admin/admins")).json() as { id: string; name: string; owner: boolean; you: boolean; phone: string }[];
    expect(list.map((a) => [a.name, a.owner, a.you])).toEqual([["Incolo admin", true, true], ["Neeraj", false, false]]);
    const ownerRow = list[0]!, neerajRow = list[1]!;
    expect(code(await api(neeraj, "DELETE", `/api/admin/admins/${ownerRow.id}`))).toBe("owner");
    expect(code(await api(owner, "DELETE", `/api/admin/admins/${ownerRow.id}`))).toBe("own_login");
    expect(code(await api(neeraj, "PATCH", `/api/admin/admins/${neerajRow.id}`, { active: false }))).toBe("own_login");
    // switched off: signed out, no admin pages, no sign-in
    expect((await api(owner, "PATCH", `/api/admin/admins/${neerajRow.id}`, { active: false })).statusCode).toBe(200);
    expect((await api(neeraj, "GET", "/api/admin/clinics")).statusCode).toBe(401);
    expect(await h.db.staffUser.findUniqueOrThrow({ where: { phoneHash: phoneHash("919811100001") } })).toMatchObject({ active: false });
    expect((await api(owner, "PATCH", `/api/admin/admins/${neerajRow.id}`, { active: true })).statusCode).toBe(200);
    expect(await h.db.staffUser.findUniqueOrThrow({ where: { phoneHash: phoneHash("919811100001") } })).toMatchObject({ active: true });
    // removed for good
    expect((await api(owner, "DELETE", `/api/admin/admins/${neerajRow.id}`)).statusCode).toBe(200);
    expect(await h.db.staffUser.findUnique({ where: { phoneHash: phoneHash("919811100001") } })).toBeNull();
    // a customer clinic's login can't be made an Incolo admin, and an admin can't be added to a clinic
    expect(code(await api(owner, "POST", "/api/admin/admins", { name: "x", phone: DOC.slice(2) }))).toBe("phone_in_use");
    expect(code(await api(await sidFor(DOC), "POST", "/api/settings/staff", { name: "x", phone: "9920323832", role: "STAFF" }))).toBe("phone_in_use");
  });
});

describe("customer clinics through their life", () => {
  it("an Incolo admin fixes a clinic's logins when the clinic can't: replace a lost doctor number", async () => {
    const admin = await incolo();
    const base = `/api/admin/clinics/${sunrise}/staff`;
    expect(code(await api(admin, "DELETE", `${base}/${await idOf(DOC)}`))).toBe("last_doctor");
    expect((await api(admin, "POST", base, { name: "Dr. Mehta (new phone)", phone: "9876500066", role: "DOCTOR" })).statusCode).toBe(200);
    expect((await api(admin, "DELETE", `${base}/${await idOf(DOC)}`)).statusCode).toBe(200);
    expect((await api(admin, "GET", `/api/admin/clinics/${sunrise}`)).json().staff.map((s: { name: string }) => s.name)).toEqual(["Dr. Mehta (new phone)"]);
    // only this clinic's logins
    expect((await api(admin, "PATCH", `${base}/${await idOf(SEED.doctorPhone)}`, { active: false })).statusCode).toBe(404);
    expect(await h.db.auditLog.count({ where: { actorType: "INCOLO", action: "staff.remove" } })).toBe(1);
  });

  it("suspend pauses everything; reactivate brings it back; archive also disconnects the number", async () => {
    const admin = await incolo();
    const doc = await sidFor(DOC);
    expect((await api(doc, "POST", "/api/whatsapp/connect", { code: "AQD-one-time-code-123", wabaId: WABA, phoneNumberId: PNID })).statusCode).toBe(200);
    await webhookHi("919812300009");
    expect(h.wa.sent.filter((s) => s.to === "919812300009").length).toBeGreaterThan(0);
    h.wa.sent.length = 0;

    expect((await api(admin, "POST", `/api/admin/clinics/${sunrise}/status`, { status: "SUSPENDED" })).statusCode).toBe(200);
    expect((await api(doc, "GET", "/api/me")).statusCode).toBe(401); // signed out
    const again = await sidFor(DOC);
    expect(code(await api(again, "GET", "/api/queue/today"))).toBe("clinic_paused");
    await h.app.inject({ method: "POST", url: "/api/auth/otp", payload: { phone: DOC } });
    expect(h.wa.sent).toHaveLength(0); // no login code
    await webhookHi("919812300010");
    expect(h.wa.sent).toHaveLength(0); // the bot doesn't answer
    expect((await api(admin, "GET", "/api/admin/clinics")).json().find((c: { id: string }) => c.id === sunrise)).toMatchObject({ status: "SUSPENDED" });

    expect((await api(admin, "POST", `/api/admin/clinics/${sunrise}/status`, { status: "ACTIVE" })).statusCode).toBe(200);
    expect((await api(again, "GET", "/api/queue/today")).statusCode).toBe(200);
    await webhookHi("919812300011");
    expect(h.wa.sent.filter((s) => s.to === "919812300011").length).toBeGreaterThan(0);

    expect((await api(admin, "POST", `/api/admin/clinics/${sunrise}/status`, { status: "ARCHIVED" })).statusCode).toBe(200);
    expect(await h.db.waConnection.findUniqueOrThrow({ where: { clinicId: sunrise } })).toMatchObject({ status: "DISCONNECTED", token: "" });
    expect(await h.db.clinic.findUniqueOrThrow({ where: { id: sunrise } })).toMatchObject({ status: "ARCHIVED" }); // data kept
    expect(await h.db.staffUser.count({ where: { clinicId: sunrise } })).toBe(1);
  });

  it("delete for good: only with the clinic's exact name; its patients and logins go, other clinics stay", async () => {
    const admin = await incolo();
    const doc = await sidFor(DOC);
    await api(doc, "POST", "/api/whatsapp/connect", { code: "AQD-one-time-code-123", wabaId: WABA, phoneNumberId: PNID });
    await webhookHi("919812300009");
    expect(await h.db.patientAccount.count({ where: { channel: sunrise } })).toBe(1);
    const demoPatients = await h.db.patientAccount.count({ where: { channel: "demo" } });
    const demoStaff = await h.db.staffUser.count({ where: { clinicId: { not: sunrise } } });
    expect(code(await api(admin, "DELETE", `/api/admin/clinics/${sunrise}`, { confirmName: "Sunrise" }))).toBe("confirm_name");
    expect((await api(admin, "DELETE", `/api/admin/clinics/${sunrise}`, { confirmName: "Sunrise Child Clinic" })).statusCode).toBe(200);
    expect(await h.db.clinic.findUnique({ where: { id: sunrise } })).toBeNull();
    expect(await h.db.patientAccount.count({ where: { channel: sunrise } })).toBe(0);
    expect(await h.db.staffUser.findUnique({ where: { phoneHash: phoneHash(DOC) } })).toBeNull();
    expect(await h.db.waConnection.findUnique({ where: { clinicId: sunrise } })).toBeNull();
    expect(await h.db.patientAccount.count({ where: { channel: "demo" } })).toBe(demoPatients);
    expect(await h.db.staffUser.count({ where: { clinicId: { not: sunrise } } })).toBe(demoStaff);
    // the number is free again: the doctor's clinic can be added afresh
    expect((await api(admin, "POST", "/api/admin/clinics", { clinicName: "Sunrise Child Clinic", doctorName: "Dr. Mehta", doctorPhone: DOC, addressShort: "Baner, Pune", clinicPhone: "+91 20 4000 5555" })).statusCode).toBe(200);
  });
});

