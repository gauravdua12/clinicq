import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encrypt, phoneHash } from "@clinicq/db";
import { buildWebhook, previewText, signBody } from "@clinicq/wa";
import { harness, onboard, type H } from "../harness";
import { createCustomerClinic } from "../../src/services/customers";
import { inScope } from "../../src/scope";
import { invalidateNumberCache } from "../../src/services/tenancy";
import { clinicInfo } from "../../src/services/clinic";

// Several clinics on one server (src/scope.ts): a customer clinic on its own WhatsApp number next to the shared demo
// number. Each clinic's patients, staff, messages, jobs and live events stay with that clinic.

let h: H;
let B: { id: string };
const PN_B = "PN_CLINIC_B";
const P = "919812300001";

beforeEach(async () => {
  h = await harness({ start: "2026-10-09T12:00:00+05:30" });
  invalidateNumberCache();
  h.ctx.wa.invalidate();
  B = await createCustomerClinic(h.ctx, { clinicName: "Sunrise Child Clinic", doctorName: "Dr. Mehta", doctorPhone: "9876500011", addressShort: "Baner, Pune", clinicPhone: "+91 20 4000 5555" }, null);
  await h.db.waConnection.create({ data: { clinicId: B.id, wabaId: "WABA_B", phoneNumberId: PN_B, displayPhone: "+91 98765 00099", verifiedName: "Sunrise Child Clinic", token: encrypt("token-b"), status: "CONNECTED" } });
});
afterEach(async () => h?.close());

async function post(pnid: string, from: string, message: Record<string, unknown>): Promise<void> {
  const payload = JSON.stringify(buildWebhook({ from, name: "Ramesh Kumar", wamid: `wamid.t.${randomUUID()}`, message, phoneNumberId: pnid }));
  const r = await h.app.inject({ method: "POST", url: "/webhook", headers: { "content-type": "application/json", "x-hub-signature-256": signBody(payload, h.ctx.env.META_APP_SECRET) }, payload });
  expect(r.statusCode).toBe(200);
}
const sayB = (from: string, text: string) => post(PN_B, from, { type: "text", text: { body: text } });
const tapB = (from: string, id: string) => post(PN_B, from, { type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: id } } });
const fromB = (to: string) => h.wa.sent.filter((s) => s.to === to && s.via === PN_B);
const fromShared = (to: string) => h.wa.sent.filter((s) => s.to === to && !s.via);
async function staffLogin(phone: string): Promise<string> {
  const staff = await h.db.staffUser.findUniqueOrThrow({ where: { phoneHash: phoneHash(phone) } });
  const sid = randomUUID();
  const { createHash } = await import("node:crypto");
  await h.db.staffSession.create({ data: { id: createHash("sha256").update(sid).digest("hex"), staffId: staff.id, expiresAt: new Date("2030-01-01") } });
  return sid;
}
const api = (sid: string, method: "GET" | "POST", url: string, payload?: object) => h.app.inject({ method, url, cookies: { sid }, ...(payload ? { payload } : {}) });

describe("a customer clinic on its own number", () => {
  it("answers on its own number, as its own clinic, with its own patient record and consent", async () => {
    await sayB(P, "Hi");
    expect(fromB(P).length).toBeGreaterThan(0);
    expect(fromShared(P)).toHaveLength(0);
    expect(fromB(P).map((m) => previewText(m.msg)).join(" ")).toContain("Sunrise Child Clinic");
    await tapB(P, "consent:yes"); await tapB(P, "num:use");
    const accB = await h.db.patientAccount.findUniqueOrThrow({ where: { channel_phoneHash: { channel: B.id, phoneHash: phoneHash(P) } } });
    expect(await h.db.consentRecord.count({ where: { accountId: accB.id } })).toBe(1);

    // the same person on the demo number: a separate account, asked for consent there too
    await onboard(h, P);
    const accounts = await h.db.patientAccount.findMany({ where: { phoneHash: phoneHash(P) } });
    expect(accounts.map((a) => a.channel).sort()).toEqual([B.id, "demo"].sort());
    expect(fromShared(P).map((m) => previewText(m.msg)).join(" ")).toContain("Dr. Sharma");
  });

  it("books with its own doctor; reminders go from its own number", async () => {
    await sayB(P, "Hi"); await tapB(P, "consent:yes"); await tapB(P, "num:use");
    await sayB(P, "book Monday morning for me");
    await tapB(P, "who:me");
    const slot = (fromB(P).at(-1)!.msg as { buttons?: { id: string }[] }).buttons?.[0]?.id;
    expect(slot).toMatch(/^slot:/);
    await tapB(P, slot!); await tapB(P, "vt:NEW"); await tapB(P, "bk:yes");
    const docB = await h.db.doctor.findFirstOrThrow({ where: { clinicId: B.id } });
    const appt = await h.db.appointment.findFirstOrThrow({ where: { status: "BOOKED" } });
    expect(appt.doctorId).toBe(docB.id);
    const sentBefore = fromShared(P).length;
    await h.at("2026-10-11T10:30:00+05:30"); // the 24-hour reminder for Monday 10:00
    expect(fromB(P).some((m) => m.msg.kind === "template" && m.msg.name === "reminder_24h")).toBe(true);
    expect(fromShared(P).length).toBe(sentBefore);
  });

  it("its staff see only their clinic; another clinic's ids answer 404", async () => {
    // a booking at the demo clinic
    await onboard(h, P); await h.say(P, "book Monday morning for me"); await h.tap(P, "who:me"); await h.tap(P, h.buttons(P)[0]!.id); await h.tap(P, "vt:NEW"); await h.tap(P, "bk:yes");
    const demoAppt = await h.db.appointment.findFirstOrThrow({ where: { status: "BOOKED" } });
    const sid = await staffLogin("919876500011");
    expect((await api(sid, "GET", "/api/clinic")).json()).toMatchObject({ name: "Sunrise Child Clinic" });
    expect((await api(sid, "GET", "/api/appointments?from=2026-10-12&to=2026-10-12")).json()).toEqual([]);
    expect((await api(sid, "POST", `/api/appointments/${demoAppt.id}/cancel`, {})).statusCode).toBe(404);
    expect((await h.db.appointment.findUniqueOrThrow({ where: { id: demoAppt.id } })).status).toBe("BOOKED");
    // the demo clinic's staff still see the demo clinic
    const demoSid = (await h.app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { role: "STAFF" } })).cookies.find((c) => c.name === "sid")!.value;
    expect((await api(demoSid, "GET", "/api/clinic")).json()).toMatchObject({ name: "Dr. Sharma's Clinic" });
    expect((await api(demoSid, "GET", "/api/appointments?from=2026-10-12&to=2026-10-12")).json()).toHaveLength(1);
  });

  it("live events and the TV display stay within the clinic", async () => {
    const seen: { demo: string[]; b: string[] } = { demo: [], b: [] };
    h.ctx.bus.subscribe((e) => seen.demo.push(e.type));
    inScope({ clinicId: B.id }, () => h.ctx.bus.subscribe((e) => seen.b.push(e.type)));
    await inScope({ clinicId: B.id }, async () => h.ctx.bus.publish({ type: "doctor.status", delayMin: 10, pauseUntil: null }));
    h.ctx.bus.publish({ type: "doctor.status", delayMin: 0, pauseUntil: null });
    expect(seen).toEqual({ demo: ["doctor.status"], b: ["doctor.status"] });
    const key = (await h.db.clinic.findUniqueOrThrow({ where: { id: B.id } })).displayKey;
    expect((await h.app.inject({ url: `/api/display/state?key=${encodeURIComponent(key)}` })).json()).toMatchObject({ clinicName: "Sunrise Child Clinic" });
  });

  it("a staff member's commands work only on their own clinic's number", async () => {
    await sayB("919876500011", "help");
    const toDoc = h.wa.sent.filter((s) => s.to === "919876500011");
    expect(toDoc.length).toBeGreaterThan(0);
    expect(toDoc.every((s) => s.via === PN_B)).toBe(true);
    expect(await h.db.patientAccount.count({ where: { phoneHash: phoneHash("919876500011"), channel: B.id } })).toBe(0); // handled as staff
  });

  it("a disconnected number is ignored; Demo Studio can't take over a customer clinic", async () => {
    await h.db.waConnection.update({ where: { clinicId: B.id }, data: { status: "DISCONNECTED" } });
    invalidateNumberCache(); h.ctx.wa.invalidate();
    await sayB(P, "Hi");
    expect(h.wa.sent.filter((s) => s.to === P)).toHaveLength(0);
    const admin = (await h.app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { role: "DOCTOR" } })).cookies.find((c) => c.name === "sid")!.value;
    const r = await api(admin, "POST", `/api/demo/${B.id}/activate`, {});
    expect([404, 409]).toContain(r.statusCode);
    expect((await clinicInfo(h.ctx)).clinic.name).toBe("Dr. Sharma's Clinic");
  });

  it("resetting a demo leaves customer clinics' conversations alone", async () => {
    await sayB(P, "Hi");
    const accB = await h.db.patientAccount.findUniqueOrThrow({ where: { channel_phoneHash: { channel: B.id, phoneHash: phoneHash(P) } } });
    expect(await h.db.conversationState.count({ where: { accountId: accB.id } })).toBe(1);
    const { resetDemo } = await import("../../src/services/demo");
    await resetDemo(h.ctx, (await clinicInfo(h.ctx)).clinic.id, null);
    expect(await h.db.conversationState.count({ where: { accountId: accB.id } })).toBe(1);
  });
});
