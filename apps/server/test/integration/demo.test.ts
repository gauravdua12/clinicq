import { afterEach, describe, expect, it } from "vitest";
import { buildWebhook, signBody } from "@clinicq/wa";
import { harness, onboard, PATIENT, type H } from "../harness";
import { buildApp } from "../../src/app";
import { loadEnv } from "../../src/env";
import { clinicInfo } from "../../src/services/clinic";
import { createDemo, deleteDemo, fetchPublicText, htmlToText, resetDemo } from "../../src/services/demo";

let h: H;
afterEach(async () => h?.close());

const PROFILE = {
  clinicName: "Sanjeevani Child Care Clinic", doctorName: "Dr. K. Iyer", qualification: "MBBS, MD (Paediatrics)", specialty: "Paediatrics",
  addressShort: "Shivajinagar, Pune", addressFull: "2nd floor, Lotus Plaza, FC Road, Pune 411005", phone: "020 2553 1188", mapsUrl: null, fees: "₹700",
  sessions: [{ days: [1, 2, 3, 4, 5, 6], label: "Morning", start: "09:30", end: "13:00" }, { days: [1, 2, 3, 4, 5, 6], label: "Evening", start: "17:00", end: "20:30" }],
};

describe("Demo Studio", () => {
  it("creates a demo from a profile, makes it active, and patients talk to it", async () => {
    h = await harness({ start: "2026-10-09T18:00:00+05:30" });
    const { clinic } = await createDemo(h.ctx, { name: PROFILE.clinicName }, null, PROFILE);
    const info = await clinicInfo(h.ctx);
    expect(info.clinic.id).toBe(clinic.id);
    expect(info.clinic.isDemo).toBe(true);
    expect(info.sessions).toHaveLength(12);
    expect(await h.db.appointment.count({ where: { doctorId: info.doctor.id } })).toBeGreaterThan(3); // sample bookings
    expect(await h.db.queueEntry.count({ where: { doctorId: info.doctor.id } })).toBe(6); // live sample queue

    await onboard(h);
    await h.say(PATIENT, "kal subah 11 baje appointment chahiye mere liye");
    const kinds = await h.kinds(PATIENT);
    expect(kinds).toContain("ASK_WHO");
    expect(h.wa.sent.some((m) => m.msg.kind !== "template" && JSON.stringify(m.msg).includes("Sanjeevani Child Care Clinic"))).toBe(true);
  });

  it("scopes data to the active clinic and can switch back", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    const home = await clinicInfo(h.ctx);
    await onboard(h);
    await h.db.patientProfile.create({ data: { accountId: (await h.db.patientAccount.findFirstOrThrow()).id, name: (await import("@clinicq/db")).encrypt("Ramesh Kumar"), relation: "SELF" } });
    await h.say(PATIENT, "book tomorrow 6:10 pm for me");
    await h.tap(PATIENT, "vt:NEW");
    const { clinic } = await createDemo(h.ctx, { name: PROFILE.clinicName }, null, PROFILE);
    // In the demo the patient has no bookings with this clinic.
    await h.say(PATIENT, "when is my appointment?");
    expect((await h.kinds(PATIENT)).at(-1)).toBe("NO_UPCOMING");
    await deleteDemo(h.ctx, clinic.id, null);
    expect((await clinicInfo(h.ctx)).clinic.id).toBe(home.clinic.id);
    await h.say(PATIENT, "when is my appointment?");
    expect((await h.kinds(PATIENT)).at(-1)).toBe("MY_APPOINTMENTS");
  });

  it("reset restores fresh sample data", async () => {
    h = await harness({ start: "2026-10-09T18:00:00+05:30" });
    const { clinic } = await createDemo(h.ctx, { name: PROFILE.clinicName }, null, PROFILE);
    const doc = (await clinicInfo(h.ctx)).doctor.id;
    await h.db.queueEntry.updateMany({ where: { doctorId: doc }, data: { state: "COMPLETED" } });
    await resetDemo(h.ctx, clinic.id, null);
    expect(await h.db.queueEntry.count({ where: { doctorId: doc, state: "WAITING" } })).toBe(2);
  });

  it("demo endpoints need a doctor login and DEMO_STUDIO", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    expect((await h.app.inject({ url: "/api/demo" })).statusCode).toBe(404); // DEMO_STUDIO off in tests
    h.ctx.env.DEMO_STUDIO = true;
    expect((await h.app.inject({ url: "/api/demo" })).statusCode).toBe(401);
    const staff = await h.app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { role: "STAFF" } });
    expect((await h.app.inject({ url: "/api/demo", cookies: { sid: staff.cookies[0]!.value } })).statusCode).toBe(403);
  });

  it("website fetcher refuses private networks and non-web schemes", async () => {
    for (const u of ["http://127.0.0.1", "http://localhost:8080", "http://169.254.169.254/latest/meta-data", "http://10.1.2.3", "http://192.168.1.1", "file:///etc/passwd", "ftp://example.com", "http://[::1]/"]) {
      await expect(fetchPublicText(u), u).rejects.toThrow();
    }
    expect(htmlToText("<script>x()</script><p>Dr. A&amp;B</p><style>p{}</style>")).toBe("Dr. A&B");
  });
});

describe("runs under a base path (app.incolo.si/clinicq)", () => {
  it("serves webhook, API and health under /clinicq only", async () => {
    const env = loadEnv({ BASE_PATH: "/clinicq" });
    const { app } = await buildApp({ env, serveStatic: false });
    expect((await app.inject({ url: "/clinicq/healthz" })).json()).toMatchObject({ ok: true });
    expect((await app.inject({ url: "/healthz" })).statusCode).toBe(404);
    const payload = JSON.stringify(buildWebhook({ from: "919800000099", wamid: "wamid.bp", message: { type: "text", text: { body: "hi" } } }));
    const res = await app.inject({ method: "POST", url: "/clinicq/webhook", headers: { "content-type": "application/json", "x-hub-signature-256": signBody(payload, env.META_APP_SECRET) }, payload });
    expect(res.statusCode).toBe(200);
    const login = await app.inject({ method: "POST", url: "/clinicq/api/auth/dev-login", payload: { role: "DOCTOR" } });
    expect(login.cookies[0]!.path).toBe("/clinicq");
    await app.close();
  });
});
