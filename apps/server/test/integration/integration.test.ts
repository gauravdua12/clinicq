import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { phoneHash } from "@clinicq/db";
import { slots as S, time as T } from "@clinicq/core";
import { buildWebhook, createPrivateKeyForTest, decryptFlowResponseForTest, encryptFlowRequestForTest, signBody } from "./helpers";
import { harness, onboard, PATIENT, SEED, type H } from "../harness";
import { holdSlot, SlotTakenError } from "../../src/services/booking";
import { windowAvailability, clinicInfo } from "../../src/services/clinic";
import { createProfile } from "../../src/services/patients";
import { purge } from "../../src/jobs/handlers";
import { advance, issueWalkin, snapshot } from "../../src/services/queue";

let h: H;
afterEach(async () => h?.close());

describe("one booking per slot under concurrency", () => {
  it("20 parallel holds on the same slot → exactly one wins", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    const info = await clinicInfo(h.ctx);
    const av = await windowAvailability(h.ctx, info);
    const slot = S.findSlot("2026-10-10", T.toMin("18:10"), av)!;
    const profiles = [];
    for (let i = 0; i < 20; i++) {
      const acc = await h.db.patientAccount.create({ data: { waPhone: "x", phoneHash: `h${i}` } });
      profiles.push(await createProfile(h.ctx, acc.id, `P${i}`, "SELF"));
    }
    const results = await Promise.allSettled(profiles.map((p) => holdSlot(h.ctx, slot, p.id, null)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected" && r.reason instanceof SlotTakenError)).toHaveLength(19);
  });

  it("parallel 'consultation completed' taps keep one Next / one In consultation", async () => {
    h = await harness({ start: "2026-10-09T17:30:00+05:30" });
    const info = await clinicInfo(h.ctx);
    const sess = info.sessions.find((s) => s.weekday === 5 && s.label === "Evening")!;
    for (let i = 0; i < 6; i++) await issueWalkin(h.ctx, { sessionId: sess.id, date: "2026-10-09", displayName: `N${i}`, actor: { type: "STAFF", id: null } });
    await Promise.allSettled([1, 2, 3, 4].map(() => advance(h.ctx, { type: "STAFF", id: null })));
    const snap = await snapshot(h.ctx);
    // the four taps were applied one after another, none lost
    expect(snap.counts.completed).toBe(3);
    const states = await h.db.queueEntry.groupBy({ by: ["state"], _count: true });
    expect(states.find((s) => s.state === "NEXT")?._count ?? 0).toBeLessThanOrEqual(1);
    expect(states.find((s) => s.state === "IN_CONSULT")?._count ?? 0).toBeLessThanOrEqual(1);
    expect(snap.inConsult).not.toBeNull();
  });
});

describe("double-tap protection", () => {
  it("a stale 'consultation completed' tap is rejected instead of skipping a patient", async () => {
    h = await harness({ start: "2026-10-09T17:30:00+05:30" });
    const info = await clinicInfo(h.ctx);
    const sess = info.sessions.find((s) => s.weekday === 5 && s.label === "Evening")!;
    for (let i = 0; i < 3; i++) await issueWalkin(h.ctx, { sessionId: sess.id, date: "2026-10-09", displayName: `N${i}`, actor: { type: "STAFF", id: null } });
    let snap = await advance(h.ctx, { type: "STAFF", id: null }, null); // send first in
    const first = snap.inConsult!.id;
    const taps = await Promise.allSettled([advance(h.ctx, { type: "STAFF", id: null }, first), advance(h.ctx, { type: "STAFF", id: null }, first)]);
    expect(taps.filter((t) => t.status === "fulfilled")).toHaveLength(1);
    snap = await snapshot(h.ctx);
    expect(snap.counts.completed).toBe(1);
  });
});

describe("webhook security", () => {
  it("rejects bad signatures and processes duplicates once", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    const payload = JSON.stringify(buildWebhook({ from: PATIENT, wamid: "wamid.dup", message: { type: "text", text: { body: "hi" } } }));
    const bad = await h.app.inject({ method: "POST", url: "/webhook", headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=deadbeef" }, payload });
    expect(bad.statusCode).toBe(401);
    for (let i = 0; i < 3; i++) {
      const ok = await h.app.inject({ method: "POST", url: "/webhook", headers: { "content-type": "application/json", "x-hub-signature-256": signBody(payload, h.ctx.env.META_APP_SECRET) }, payload });
      expect(ok.statusCode).toBe(200);
    }
    expect(h.wa.to(PATIENT)).toHaveLength(1);
  });

  it("answers Meta's verification challenge only with the right token", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    const ok = await h.app.inject({ url: `/webhook?hub.mode=subscribe&hub.verify_token=${h.ctx.env.META_VERIFY_TOKEN}&hub.challenge=42` });
    expect(ok.body).toBe("42");
    expect((await h.app.inject({ url: "/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42" })).statusCode).toBe(403);
  });
});

describe("WhatsApp Flow data endpoint", () => {
  it("decrypts, lists slots, holds on selection, and rejects bad keys with 421", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    h.ctx.flowKey = createPrivateKeyForTest(privateKey);
    await onboard(h);
    const acc = await h.db.patientAccount.findUniqueOrThrow({ where: { phoneHash: phoneHash(PATIENT) } });
    const prof = await createProfile(h.ctx, acc.id, "Ramesh Kumar", "SELF");
    const token = randomUUID();
    await h.db.flowToken.create({ data: { token, accountId: acc.id, profileId: prof.id, expiresAt: new Date("2026-10-09T13:00:00+05:30") } });
    const call = async (payload: unknown) => {
      const { body, aesKey, iv } = encryptFlowRequestForTest(payload, publicKey);
      const res = await h.app.inject({ method: "POST", url: "/flow", headers: { "content-type": "application/json" }, payload: JSON.stringify(body) });
      return { status: res.statusCode, data: res.statusCode === 200 ? (decryptFlowResponseForTest(res.body, aesKey, iv) as { screen?: string; data: Record<string, unknown> }) : null };
    };
    expect((await call({ action: "ping", version: "3.0" })).data).toEqual({ data: { status: "active" } });
    const init = await call({ action: "INIT", flow_token: token, version: "3.0" });
    expect(init.data?.screen).toBe("PICK_DATE_SLOT");
    expect((init.data?.data.dates as { id: string; enabled: boolean }[]).find((d) => d.id === "2026-10-11")?.enabled).toBe(false); // Sunday closed
    const pick = await call({ action: "data_exchange", flow_token: token, data: { action: "slot_selected", slot: "2026-10-10|1090" } });
    expect(pick.data?.screen).toBe("CONFIRM");
    expect(await h.db.appointment.count({ where: { status: "HELD" } })).toBe(1);
    const other = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    const { body } = encryptFlowRequestForTest({ action: "ping" }, other.publicKey);
    expect((await h.app.inject({ method: "POST", url: "/flow", headers: { "content-type": "application/json" }, payload: JSON.stringify(body) })).statusCode).toBe(421);
    // completion arrives in chat → visit type → confirmed
    await h.flow(PATIENT, { slot: "2026-10-10|1090", flow_token: token });
    expect((await h.kinds(PATIENT)).at(-1)).toBe("ASK_VISIT_TYPE");
    await h.tap(PATIENT, "vt:NEW");
    expect((await h.kinds(PATIENT)).at(-1)).toBe("BOOKING_CONFIRMED");
    expect(await h.db.appointment.count({ where: { status: "BOOKED" } })).toBe(1);
  });
});

describe("privacy", () => {
  it("'delete my data' erases the account and cancels bookings", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    await onboard(h);
    await createProfile(h.ctx, (await h.db.patientAccount.findFirstOrThrow()).id, "Ramesh Kumar", "SELF");
    await h.say(PATIENT, "book tomorrow 6:10 pm for me");
    await h.tap(PATIENT, "vt:NEW");
    await h.say(PATIENT, "delete my data");
    await h.tap(PATIENT, "erase:yes");
    expect(await h.db.patientAccount.count()).toBe(0);
    expect(await h.db.patientProfile.count()).toBe(0);
    const a = await h.db.appointment.findFirstOrThrow();
    expect(a.status).toBe("CANCELLED");
    expect(a.profileId).toBeNull();
    expect(await h.db.dataRequest.count({ where: { type: "ERASURE" } })).toBe(1);
  });

  it("purge anonymises old visits and deletes inactive accounts", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    await onboard(h);
    await createProfile(h.ctx, (await h.db.patientAccount.findFirstOrThrow()).id, "Ramesh Kumar", "SELF");
    await h.say(PATIENT, "book tomorrow 6:10 pm for me");
    await h.tap(PATIENT, "vt:NEW");
    h.clock.set("2027-04-20T12:00:00+05:30"); // ~6.4 months later
    let r = await purge(h.ctx);
    expect(r.visits).toBe(1);
    expect(r.messageLog).toBeGreaterThan(0);
    expect(await h.db.patientAccount.count()).toBe(1);
    h.clock.set("2027-11-20T12:00:00+05:30"); // > 12 months inactive
    r = await purge(h.ctx);
    expect(r.accounts).toBe(1);
  });

  it("STOP suppresses reminders but replies still work", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    await onboard(h);
    await createProfile(h.ctx, (await h.db.patientAccount.findFirstOrThrow()).id, "Ramesh Kumar", "SELF");
    await h.say(PATIENT, "book Monday 10:20 am for me");
    await h.tap(PATIENT, "vt:NEW");
    await h.say(PATIENT, "stop sending messages");
    expect((await h.kinds(PATIENT)).at(-1)).toBe("OPTED_OUT");
    await h.at("2026-10-11T10:20:00+05:30");
    expect((await h.kinds(PATIENT)).at(-1)).toBe("suppressed:REMINDER_24H");
  });
});

describe("staff login and admin model switch", () => {
  it("OTP login, wrong code rejected, role checks", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    await h.app.inject({ method: "POST", url: "/api/auth/otp", payload: { phone: "99999 00002" } });
    const otp = h.wa.last(SEED.staffPhone);
    expect(otp?.kind).toBe("template");
    const code = otp?.kind === "template" ? otp.bodyParams[0]! : "";
    expect((await h.app.inject({ method: "POST", url: "/api/auth/verify", payload: { phone: "9999900002", code: "000000" } })).statusCode).toBe(401);
    const ok = await h.app.inject({ method: "POST", url: "/api/auth/verify", payload: { phone: "9999900002", code } });
    expect(ok.statusCode).toBe(200);
    const cookie = ok.cookies.find((c) => c.name === "sid")!;
    expect((await h.app.inject({ url: "/api/queue/today", cookies: { sid: cookie.value } })).statusCode).toBe(200);
    expect((await h.app.inject({ url: "/api/settings/ai", cookies: { sid: cookie.value } })).statusCode).toBe(403); // staff isn't admin
    expect((await h.app.inject({ url: "/api/queue/today" })).statusCode).toBe(401);
  });

  it("OTP template carries the code on its copy button; falls back to a plain message if the template send fails", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    await h.app.inject({ method: "POST", url: "/api/auth/otp", payload: { phone: "99999 00002" } });
    const t = h.wa.last(SEED.staffPhone);
    expect(t?.kind === "template" && t.otpCode).toBe(t?.kind === "template" ? t.bodyParams[0] : "x");
    await h.db.otpChallenge.deleteMany({});
    h.wa.failNext = 1; // e.g. template not approved yet
    await h.app.inject({ method: "POST", url: "/api/auth/otp", payload: { phone: "99999 00002" } });
    const fb = h.wa.last(SEED.staffPhone);
    expect(fb?.kind).toBe("text");
    const code = fb?.kind === "text" ? /\d{6}/.exec(fb.body)![0] : "";
    expect((await h.app.inject({ method: "POST", url: "/api/auth/verify", payload: { phone: "9999900002", code } })).statusCode).toBe(200);
  });

  it("doctor can switch the model; bad specs are rejected", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    const login = await h.app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { role: "DOCTOR" } });
    const sid = login.cookies.find((c) => c.name === "sid")!.value;
    const bad = await h.app.inject({ method: "PUT", url: "/api/settings/ai", cookies: { sid }, payload: { primary: "rm -rf" } });
    expect(bad.statusCode).toBe(422);
    const ok = await h.app.inject({ method: "PUT", url: "/api/settings/ai", cookies: { sid }, payload: { primary: "rules", escalation: "", minConfidence: 0.75 } });
    expect(ok.statusCode).toBe(200);
    const cfg = await h.app.inject({ url: "/api/settings/ai", cookies: { sid } });
    expect(cfg.json().config.minConfidence).toBe(0.75);
    expect(await h.db.auditLog.count({ where: { action: "settings.ai" } })).toBe(1);
  });
});

describe("time-shared demo server: Meta re-deliveries after downtime", () => {
  it("does not act on old messages; sends one 'please send again'; fresh messages work", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    (h.ctx.env as { WA_MODE: string }).WA_MODE = "cloud"; // the guard applies to real Meta traffic only
    const post = async (body: string, ageMin: number) => {
      const p = buildWebhook({ from: PATIENT, name: "Ramesh Kumar", wamid: `wamid.t.${randomUUID()}`, message: { type: "text", text: { body } } }) as { entry: { changes: { value: { messages: { timestamp: string }[] } }[] }[] };
      p.entry[0]!.changes[0]!.value.messages[0]!.timestamp = String(Math.floor((h.clock.now().getTime() - ageMin * 60_000) / 1000));
      const raw = JSON.stringify(p);
      return h.app.inject({ method: "POST", url: "/webhook", headers: { "content-type": "application/json", "x-hub-signature-256": signBody(raw, h.ctx.env.META_APP_SECRET) }, payload: raw });
    };
    expect((await post("kal shaam 6 baje appointment chahiye", 120)).statusCode).toBe(200);
    expect((await post("aur ek baat", 115)).statusCode).toBe(200);
    const sent = h.wa.to(PATIENT);
    expect(sent).toHaveLength(1); // one apology for the whole backlog, nothing acted on
    expect(sent[0]?.kind === "text" && sent[0].body).toMatch(/dobara bhejein/);
    expect(await h.db.patientAccount.count()).toBe(0);
    await post("Hi", 0);
    expect(h.wa.to(PATIENT).length).toBeGreaterThan(1); // fresh message → normal conversation
  });
});
