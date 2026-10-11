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
    // Morning and Evening chips for the selected day; booked slots are greyed out (enabled: false)
    await holdSlot(h.ctx, (await windowAvailability(h.ctx, await clinicInfo(h.ctx))) && { date: "2026-10-10", sessionId: (await clinicInfo(h.ctx)).sessions.find((x) => x.label === "Evening" && x.weekday === 6)!.id, sessionLabel: "Evening", startMin: 1110, endMin: 1130, index: 5 }, prof.id, acc.id).catch(() => undefined);
    const day = await call({ action: "data_exchange", flow_token: token, data: { action: "date_selected", date: ["2026-10-10"] } });
    const d = day.data!.data as { selected_date: string[]; morning: { id: string; title: string; enabled: boolean }[]; evening: { id: string; title: string; enabled: boolean }[]; has_morning: boolean; has_evening: boolean; evening_label: string };
    expect(d.selected_date).toEqual(["2026-10-10"]);
    expect(d.has_morning && d.has_evening).toBe(true);
    expect(d.morning.length).toBe(9); // 10:00 … 12:40, all shown
    expect(d.evening.find((c) => c.id === "2026-10-10|1110")?.enabled).toBe(false); // held → greyed
    expect(d.evening.find((c) => c.id === "2026-10-10|1090")).toMatchObject({ title: "6:10", enabled: true });
    expect(d.evening_label).toMatch(/^Evening · 5:10 PM – 7:50 PM$/);
    await h.db.appointment.deleteMany({});
    const two = await call({ action: "data_exchange", flow_token: token, data: { action: "slot_selected", date: ["2026-10-10"], morning: ["2026-10-10|600"], evening: ["2026-10-10|1090"] } });
    expect((two.data!.data as { error_message: string }).error_message).toMatch(/just one/);
    const pick = await call({ action: "data_exchange", flow_token: token, data: { action: "slot_selected", date: ["2026-10-10"], morning: [], evening: ["2026-10-10|1090"] } });
    expect(pick.data?.screen).toBe("CONFIRM");
    expect(await h.db.appointment.count({ where: { status: "HELD" } })).toBe(1);
    const other = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    const { body } = encryptFlowRequestForTest({ action: "ping" }, other.publicKey);
    expect((await h.app.inject({ method: "POST", url: "/flow", headers: { "content-type": "application/json" }, payload: JSON.stringify(body) })).statusCode).toBe(421);
    // completion arrives in chat → visit type → confirmed
    await h.flow(PATIENT, { slot: "2026-10-10|1090", flow_token: token });
    expect((await h.kinds(PATIENT)).at(-1)).toBe("ASK_VISIT_TYPE");
    await h.tap(PATIENT, "vt:NEW");
    await h.tap(PATIENT, "bk:yes"); // final confirmation
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
    await h.tap(PATIENT, "bk:yes"); // final confirmation
    await h.say(PATIENT, "delete my data");
    await h.tap(PATIENT, "erase:yes");
    expect(await h.db.patientAccount.count()).toBe(0);
    expect(await h.db.patientProfile.count()).toBe(0);
    const a = await h.db.appointment.findFirstOrThrow();
    expect(a.status).toBe("CANCELLED");
    expect(a.profileId).toBeNull();
    expect(await h.db.dataRequest.count({ where: { type: "ERASURE" } })).toBe(1);
  });

  it("erasure leaves nothing behind even if WhatsApp can't deliver the confirmation", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    await onboard(h);
    await h.say(PATIENT, "delete my data");
    h.wa.failNext = 10; // Meta outage / closed 24 h window while erasing
    await h.tap(PATIENT, "erase:yes");
    expect(await h.db.patientAccount.count()).toBe(0);
    expect(await h.db.conversationState.count()).toBe(0);
  });

  it("purge anonymises old visits and deletes inactive accounts", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    await onboard(h);
    await createProfile(h.ctx, (await h.db.patientAccount.findFirstOrThrow()).id, "Ramesh Kumar", "SELF");
    await h.say(PATIENT, "book tomorrow 6:10 pm for me");
    await h.tap(PATIENT, "vt:NEW");
    await h.tap(PATIENT, "bk:yes"); // final confirmation
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
    await h.tap(PATIENT, "bk:yes"); // final confirmation
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

describe("demo presenter: doctor and patient on one phone", () => {
  it("plain messages go to the patient side, #commands to the desk; other staff unchanged", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    const prev = process.env.DEMO_PRESENTER_PHONES;
    process.env.DEMO_PRESENTER_PHONES = "9999900002"; // the seeded staff member acts as presenter
    try {
      await h.say(SEED.staffPhone, "Hi");
      const welcome = h.wa.last(SEED.staffPhone);
      expect(welcome?.kind).toBe("buttons"); // privacy notice + "I agree"
      expect(welcome?.kind === "buttons" && welcome.buttons.some((b) => b.id === "consent:yes")).toBe(true);
      await h.say(SEED.staffPhone, "#status");
      const snap = h.wa.last(SEED.staffPhone);
      expect(snap?.kind === "text" && /Waiting|Next|consultation/i.test(snap.body)).toBe(true);
      await h.say(SEED.staffPhone, "#");
      const help = h.wa.last(SEED.staffPhone);
      expect(help?.kind === "text" && help.body).toMatch(/#NEXT/);
      process.env.DEMO_PRESENTER_PHONES = "";
      await h.say(SEED.doctorPhone, "Hi"); // a real doctor's number: desk commands as before
      expect(h.wa.last(SEED.doctorPhone)?.kind === "text" && (h.wa.last(SEED.doctorPhone) as { body: string }).body).toMatch(/^Commands:/);
    } finally {
      if (prev === undefined) delete process.env.DEMO_PRESENTER_PHONES; else process.env.DEMO_PRESENTER_PHONES = prev;
    }
  });
});

describe("phone-test feedback (11 Oct 2026)", () => {
  it("#1 list fallback: a day with more than 10 free slots asks Morning/Evening first, then lists that session in full", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    Object.assign(h.ctx.env, { BOOKING_PAGE: false }); // the list is the fallback when the booking page can't be used
    await onboard(h);
    await createProfile(h.ctx, (await h.db.patientAccount.findFirstOrThrow()).id, "Ramesh Kumar", "SELF");
    await h.say(PATIENT, "book monday for me"); // a full day: 9 morning + 9 evening free slots
    await h.tap(PATIENT, "see_all");
    const ask = h.wa.last(PATIENT);
    expect(ask?.kind).toBe("buttons");
    const evening = ask?.kind === "buttons" ? ask.buttons.find((b) => b.title.startsWith("Evening"))! : null;
    expect(evening?.title).toBe("Evening (5:10–8pm)"); // session hours beside the name
    expect(ask?.kind === "buttons" && ask.buttons[0]!.title).toBe("Morning (10am–1pm)");
    await h.tap(PATIENT, evening!.id);
    const list = h.wa.last(PATIENT);
    expect(list?.kind).toBe("list");
    const rows = list?.kind === "list" ? list.sections.flatMap((s) => s.rows) : [];
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((r) => / PM$/.test(r.title))).toBe(true);
    Object.assign(h.ctx.env, { BOOKING_PAGE: true });
  });

  it("#2 booking form opens as soon as the patient wants to book (draft mode until Meta publishes it)", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    h.ctx.flowKey = createPrivateKeyForTest(privateKey);
    Object.assign(h.ctx.env, { WA_FLOW_ID_BOOKING: "1459463439439703", WA_FLOW_MODE: "draft", BOOKING_PAGE: false }); // native WhatsApp form
    await onboard(h);
    await createProfile(h.ctx, (await h.db.patientAccount.findFirstOrThrow()).id, "Ramesh Kumar", "SELF");
    await h.say(PATIENT, "I want to book an appointment for me");
    const f = h.wa.last(PATIENT);
    expect(f?.kind).toBe("flow");
    expect(f?.kind === "flow" && f.draft).toBe(true);
    const { toCloudPayload } = await import("@clinicq/wa");
    expect(JSON.stringify(toCloudPayload(PATIENT, f!))).toContain('"mode":"draft"');
    Object.assign(h.ctx.env, { WA_FLOW_ID_BOOKING: undefined, WA_FLOW_MODE: "published", BOOKING_PAGE: true });
  });

  it("#3 'sure' after a completed cancellation gets a polite close, not the menu", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    await onboard(h);
    await createProfile(h.ctx, (await h.db.patientAccount.findFirstOrThrow()).id, "Ramesh Kumar", "SELF");
    await h.say(PATIENT, "book tomorrow 6:10 pm for me");
    await h.tap(PATIENT, "vt:NEW");
    await h.tap(PATIENT, "bk:yes"); // final confirmation
    await h.say(PATIENT, "cancel my appointment");
    if ((await h.kinds(PATIENT)).at(-1) !== "CX_DONE") await h.tap(PATIENT, `cx:yes:${(await h.db.appointment.findFirstOrThrow()).id}`);
    expect((await h.kinds(PATIENT)).at(-1)).toBe("CX_DONE");
    await h.say(PATIENT, "Sure");
    expect((await h.kinds(PATIENT)).at(-1)).toBe("ACK_CLOSING");
    await h.say(PATIENT, "ok"); // a second acknowledgement still closes politely
    expect((await h.kinds(PATIENT)).at(-1)).toBe("ACK_CLOSING");
  });

  it("#4 queue status without a booking today says it's only for bookings (and shows the next one if any)", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    await onboard(h);
    await createProfile(h.ctx, (await h.db.patientAccount.findFirstOrThrow()).id, "Ramesh Kumar", "SELF");
    await h.tap(PATIENT, "menu:status");
    const none = h.wa.last(PATIENT);
    expect(none?.kind === "buttons" && none.body).toMatch(/^Queue status is visible for your bookings only\./);
    await h.say(PATIENT, "book tomorrow 6:10 pm for me");
    await h.tap(PATIENT, "vt:NEW");
    await h.tap(PATIENT, "bk:yes"); // final confirmation
    await h.tap(PATIENT, "menu:status");
    const fut = h.wa.last(PATIENT);
    expect(fut?.kind === "text" && fut.body).toMatch(/visible for your bookings only.*Sat 10 Oct, 6:10 PM/s);
  });

  it("#5 visit type is explained, labelled 'Report review', and shown in the confirmation", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    await onboard(h);
    await createProfile(h.ctx, (await h.db.patientAccount.findFirstOrThrow()).id, "Ramesh Kumar", "SELF");
    await h.say(PATIENT, "book tomorrow 6:10 pm for me");
    const q = h.wa.last(PATIENT);
    expect(q?.kind === "buttons" && q.body).toMatch(/test reports reviewed by the doctor/);
    expect(q?.kind === "buttons" && q.buttons.map((b) => b.title)).toEqual(["New consultation", "Follow-up", "Report review"]);
    await h.tap(PATIENT, "vt:REPORT_SHOW");
    await h.tap(PATIENT, "bk:yes"); // final confirmation
    const c = h.wa.last(PATIENT);
    expect(c?.kind === "buttons" && c.body).toMatch(/6:10 PM · Report review/);
  });
});

describe("booking form delivery failure", () => {
  it("falls back to the slot list if Meta won't deliver the form", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    h.ctx.flowKey = createPrivateKeyForTest(privateKey);
    Object.assign(h.ctx.env, { WA_FLOW_ID_BOOKING: "1459463439439703", WA_FLOW_MODE: "draft" });
    await onboard(h);
    await createProfile(h.ctx, (await h.db.patientAccount.findFirstOrThrow()).id, "Ramesh Kumar", "SELF");
    h.wa.failNext = 1; // the form message is refused
    await h.say(PATIENT, "I want to book an appointment for me");
    const last = h.wa.last(PATIENT);
    expect(["list", "buttons"]).toContain(last?.kind); // list, or Morning/Evening first on a full day
    Object.assign(h.ctx.env, { WA_FLOW_ID_BOOKING: undefined, WA_FLOW_MODE: "published" });
  });
});

describe("booking page (form D, opened from WhatsApp)", () => {
  const start = async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    await onboard(h);
    await createProfile(h.ctx, (await h.db.patientAccount.findFirstOrThrow()).id, "Ramesh Kumar", "SELF");
    await h.say(PATIENT, "I want to book an appointment for me");
    const m = h.wa.last(PATIENT);
    expect(m?.kind).toBe("cta_url");
    return (m as { url: string }).url.split("t=")[1]!;
  };

  it("shows the week and every slot of a day; books only on confirm; link works once", async () => {
    const token = await start();
    const info = (await h.app.inject({ url: `/api/book/${token}` })).json();
    expect(info.name).toBe("Ramesh");
    expect(info.dates.find((d: { date: string }) => d.date === "2026-10-11").enabled).toBe(false); // Sunday closed
    const day = (await h.app.inject({ url: `/api/book/${token}/day/2026-10-12` })).json();
    expect(day.sessions.map((s: { label: string }) => s.label)).toEqual(["Morning", "Evening"]);
    expect(day.sessions[0].slots.length).toBe(9);
    expect(await h.db.appointment.count()).toBe(0); // looking books nothing
    const ok = await h.app.inject({ method: "POST", url: `/api/book/${token}/confirm`, payload: { date: "2026-10-12", min: 1090, visitType: "FOLLOW_UP" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, time: "6:10 PM", visitType: "FOLLOW_UP" });
    const a = await h.db.appointment.findFirstOrThrow({ where: { status: "BOOKED" } });
    expect(a.visitType).toBe("FOLLOW_UP");
    expect((await h.kinds(PATIENT)).at(-1)).toBe("BOOKING_CONFIRMED"); // confirmation also arrives in WhatsApp
    expect(h.lastText(PATIENT)).toMatch(/Mon 12 Oct, 6:10 PM · Follow-up/);
    expect((await h.app.inject({ url: `/api/book/${token}` })).statusCode).toBe(410); // one use
    expect((await h.db.conversationState.findFirstOrThrow()).state).toBe("IDLE");
  });

  it("a slot taken meanwhile is refused with fresh slots; bad input and expired links are rejected", async () => {
    const token = await start();
    const info = await clinicInfo(h.ctx);
    const other = await createProfile(h.ctx, (await h.db.patientAccount.findFirstOrThrow()).id, "Aarav", "SON");
    void other;
    await h.db.appointment.create({ data: { doctorId: info.doctor.id, sessionId: info.sessions.find((s) => s.weekday === 1 && s.label === "Evening")!.id, slotStart: new Date("2026-10-12T18:10:00+05:30"), slotKey: `${info.doctor.id}:${new Date("2026-10-12T18:10:00+05:30").toISOString()}`, status: "BOOKED", visitType: "NEW", token: "A-9", bookedAt: new Date(), source: "WHATSAPP" } });
    const taken = await h.app.inject({ method: "POST", url: `/api/book/${token}/confirm`, payload: { date: "2026-10-12", min: 1090, visitType: "NEW" } });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().sessions[1].slots.find((s: { min: number }) => s.min === 1090).free).toBe(false); // greyed on the page
    expect((await h.app.inject({ method: "POST", url: `/api/book/${token}/confirm`, payload: { date: "12-10-2026", min: 1090, visitType: "NEW" } })).statusCode).toBe(400);
    expect((await h.app.inject({ url: "/api/book/not-a-real-token-at-all-xxxx" })).statusCode).toBe(410);
    h.clock.advance(31 * 60_000);
    expect((await h.app.inject({ url: `/api/book/${token}` })).statusCode).toBe(410); // 30-minute link
  });
});

describe("sessions with a set number of slots", () => {
  it("shows exactly the number of slots the doctor sets (50 per session)", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    const login = await h.app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { role: "DOCTOR" } });
    const sid = login.cookies.find((c) => c.name === "sid")!.value;
    const body = [{ weekday: 1, label: "Morning", startTime: "10:00", endTime: "13:00", slotMinutes: 3, maxSlots: 50, walkinQuota: 8 }, { weekday: 1, label: "Evening", startTime: "17:00", endTime: "20:00", slotMinutes: 3, maxSlots: 50, walkinQuota: 8 }];
    expect((await h.app.inject({ method: "PUT", url: "/api/settings/sessions", cookies: { sid }, payload: body })).statusCode).toBe(200);
    const avail = await windowAvailability(h.ctx, await clinicInfo(h.ctx));
    const mon = S.freeSlotsOn("2026-10-12", avail);
    expect(mon.filter((s) => s.sessionLabel === "Morning").length).toBe(50);
    expect(mon.filter((s) => s.sessionLabel === "Evening").length).toBe(50);
    expect(mon.filter((s) => s.sessionLabel === "Morning").at(-1)!.startMin).toBe(10 * 60 + 49 * 3); // 12:27, not 12:57
  });
});

describe("internal (Incolo) admin only", () => {
  it("a clinic's doctor can't see or change the language model or open Demo Studio in production", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    const login = await h.app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { role: "DOCTOR" } });
    const sid = login.cookies.find((c) => c.name === "sid")!.value;
    const prev = { DEV_TOOLS: h.ctx.env.DEV_TOOLS, INCOLO_ADMIN_PHONES: h.ctx.env.INCOLO_ADMIN_PHONES, DEMO_STUDIO: h.ctx.env.DEMO_STUDIO };
    Object.assign(h.ctx.env, { DEV_TOOLS: false, INCOLO_ADMIN_PHONES: "", DEMO_STUDIO: true }); // production rules
    try {
      expect((await h.app.inject({ url: "/api/me", cookies: { sid } })).json()).toMatchObject({ role: "DOCTOR", incoloAdmin: false });
      expect((await h.app.inject({ url: "/api/settings/ai", cookies: { sid } })).statusCode).toBe(403);
      expect((await h.app.inject({ method: "PUT", url: "/api/settings/ai", cookies: { sid }, payload: { primary: "rules" } })).statusCode).toBe(403);
      expect((await h.app.inject({ url: "/api/demo", cookies: { sid } })).statusCode).toBe(403);
      expect((await h.app.inject({ url: "/api/settings/sessions", cookies: { sid } })).statusCode).toBe(200); // clinic settings stay theirs
      h.ctx.env.INCOLO_ADMIN_PHONES = "9999900001"; // this person is Incolo's internal admin
      expect((await h.app.inject({ url: "/api/me", cookies: { sid } })).json()).toMatchObject({ incoloAdmin: true });
      expect((await h.app.inject({ url: "/api/settings/ai", cookies: { sid } })).statusCode).toBe(200);
    } finally {
      Object.assign(h.ctx.env, prev);
    }
  });
});

describe("slot picker setting (console switch)", () => {
  it("'page' sends the booking-page button; 'chat' keeps the in-chat buttons and lists", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    const login = await h.app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { role: "DOCTOR" } });
    const sid = login.cookies.find((c) => c.name === "sid")!.value;
    const cur = (await h.app.inject({ url: "/api/settings/clinic", cookies: { sid } })).json();
    expect(cur.settings.slotPicker).toBe("page"); // default
    await onboard(h);
    await createProfile(h.ctx, (await h.db.patientAccount.findFirstOrThrow()).id, "Ramesh Kumar", "SELF");
    await h.say(PATIENT, "book appointment for me");
    expect((await h.kinds(PATIENT)).at(-1)).toBe("BOOK_LINK");
    const put = await h.app.inject({ method: "PUT", url: "/api/settings/clinic", cookies: { sid }, payload: { ...cur, settings: { ...cur.settings, slotPicker: "chat" } } });
    expect(put.statusCode).toBe(200);
    const { invalidateClinicCache } = await import("../../src/services/clinic");
    invalidateClinicCache();
    await h.say(PATIENT, "book appointment for me on monday");
    await h.tap(PATIENT, "see_all");
    expect(["LIST_PICK_SESSION", "LIST_PICKER"]).toContain((await h.kinds(PATIENT)).at(-1)); // in-chat format
  });
});

describe("coming back to an unfinished chat", () => {
  const midBooking = async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    Object.assign(h.ctx.env, { BOOKING_PAGE: false }); // ask "which day and time?" in chat
    await onboard(h);
    await createProfile(h.ctx, (await h.db.patientAccount.findFirstOrThrow()).id, "Ramesh Kumar", "SELF");
    await h.say(PATIENT, "book for me");
    expect((await h.kinds(PATIENT)).at(-1)).toBe("ASK_WHEN");
  };
  afterEach(() => { if (h) Object.assign(h.ctx.env, { BOOKING_PAGE: true }); });

  it("welcome message tells patients unfinished chats restart after 30 minutes", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    await h.say(PATIENT, "Hi");
    const w = h.wa.last(PATIENT);
    expect(w?.kind === "buttons" && w.body).toMatch(/unfinished for 30 minutes, I'll start fresh/);
  });

  it("after 30 minutes away: told it starts fresh, then 'hi' gets the menu (not the old question)", async () => {
    await midBooking();
    h.clock.advance(31 * 60_000);
    await h.say(PATIENT, "Hi");
    expect((await h.kinds(PATIENT)).slice(-2)).toEqual(["SESSION_RESTARTED", "MAIN_MENU"]);
    h.clock.advance(31 * 60_000);
    await h.tap(PATIENT, "see_all"); // an old button from the expired chat
    expect((await h.kinds(PATIENT)).slice(-1)).toEqual(["MAIN_MENU"]); // nothing pending any more → no notice, just the menu
  });

  it("an old slot button after the reset leads to the menu, not a half booking", async () => {
    await midBooking();
    await h.say(PATIENT, "tomorrow evening");
    h.clock.advance(31 * 60_000);
    await h.tap(PATIENT, "slot:2026-10-10|1090");
    expect((await h.kinds(PATIENT)).slice(-2)).toEqual(["SESSION_RESTARTED", "MAIN_MENU"]);
    expect(await h.db.appointment.count({ where: { status: { in: ["HELD", "BOOKED"] } } })).toBe(0);
  });

  it("'hi' mid-booking: hello again, continue / new booking / something else", async () => {
    await midBooking();
    await h.say(PATIENT, "Hi");
    const m = h.wa.last(PATIENT);
    expect(m?.kind === "buttons" && m.body).toMatch(/Hello again 👋 We were in the middle of a booking for Ramesh ji/);
    expect(m?.kind === "buttons" && m.buttons.map((b) => b.title)).toEqual(["Continue", "New booking", "Something else"]);
    await h.tap(PATIENT, "resume:go");
    expect((await h.kinds(PATIENT)).at(-1)).toBe("RESUME_PROMPT");
    await h.say(PATIENT, "hello");
    await h.tap(PATIENT, "resume:menu");
    expect((await h.kinds(PATIENT)).at(-1)).toBe("MAIN_MENU");
  });

  it("'I don't want to book' stops the booking and frees the held slot", async () => {
    await midBooking();
    await h.say(PATIENT, "tomorrow 6:10 pm");
    expect(await h.db.appointment.count({ where: { status: "HELD" } })).toBe(1);
    await h.say(PATIENT, "I don't want to book now");
    expect((await h.kinds(PATIENT)).at(-1)).toBe("BOOKING_STOPPED");
    expect(await h.db.appointment.count({ where: { status: "HELD" } })).toBe(0);
    await h.say(PATIENT, "ok");
    expect((await h.kinds(PATIENT)).at(-1)).not.toBe("ASK_WHEN");
  });

  it("'rehne do' / 'start over' / 'new booking' each do what they say", async () => {
    await midBooking();
    await h.say(PATIENT, "rehne do");
    expect((await h.kinds(PATIENT)).at(-1)).toBe("BOOKING_STOPPED");
    await h.say(PATIENT, "book for me");
    await h.say(PATIENT, "start over");
    expect((await h.kinds(PATIENT)).at(-1)).toBe("STARTED_OVER");
    await h.say(PATIENT, "book for me");
    await h.say(PATIENT, "I want a new booking");
    expect((await h.kinds(PATIENT)).at(-1)).toBe("ASK_WHEN"); // a fresh booking, not the retry prompt
  });

  it("a reply without a day doesn't repeat the question: offers free times or stopping", async () => {
    await midBooking();
    await h.say(PATIENT, "hmm let me see");
    const m = h.wa.last(PATIENT);
    expect(m?.kind === "buttons" && m.buttons.map((b) => b.title)).toEqual(["Show free times", "Stop booking"]);
    await h.tap(PATIENT, "bk:stop");
    expect((await h.kinds(PATIENT)).at(-1)).toBe("BOOKING_STOPPED");
  });
});

describe("language choice", () => {
  it("menu offers Change language; the choice sticks until changed; typed requests work", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    await onboard(h);
    await h.say(PATIENT, "Hi");
    const m = h.wa.last(PATIENT);
    expect(m?.kind).toBe("list"); // WhatsApp allows 3 buttons; the menu needs 4 options
    expect(h.buttons(PATIENT).map((b) => b.title)).toEqual(["Book appointment", "My appointments", "Queue status", "Change language"]);
    await h.tap(PATIENT, "menu:lang");
    expect(h.buttons(PATIENT).map((b) => b.title)).toEqual(["English", "हिंदी", "Hinglish"]);
    await h.tap(PATIENT, "lang:hi");
    const kinds = await h.kinds(PATIENT);
    expect(kinds.slice(-2)).toEqual(["LANGUAGE_SET", "MAIN_MENU"]);
    expect(h.wa.to(PATIENT).at(-2)?.kind === "text" && (h.wa.to(PATIENT).at(-2) as { body: string }).body).toMatch(/हिंदी में/);
    await h.say(PATIENT, "what are the clinic timings"); // typed in English, reply stays Hindi
    expect(h.lastText(PATIENT)).toMatch(/[ऀ-ॿ]/);
    await h.say(PATIENT, "English please");
    expect((await h.kinds(PATIENT)).slice(-2)).toEqual(["LANGUAGE_SET", "MAIN_MENU"]);
    await h.say(PATIENT, "clinic kahan hai");
    expect(h.lastText(PATIENT)).not.toMatch(/[ऀ-ॿ]/);
    await h.say(PATIENT, "change language");
    expect(h.buttons(PATIENT).map((b) => b.title)).toEqual(["English", "हिंदी", "Hinglish"]);
  });
});
