import { afterEach, describe, expect, it } from "vitest";
import { phoneHash } from "@clinicq/db";
import { harness, onboard, PATIENT, PATIENT2, SEED, type H } from "../harness";
import { createProfile } from "../../src/services/patients";
import { dailyCode } from "../../src/services/walkin";

// Approved scenarios S2–S6 (docs/CONVERSATION_GUIDE.md §7). Calendar: Fri 9 Oct 2026; Sat 10; Mon 12.

let h: H;
afterEach(async () => h?.close());

async function accountId(h: H, wa: string): Promise<string> {
  return (await h.db.patientAccount.findUniqueOrThrow({ where: { phoneHash: phoneHash(wa) } })).id;
}
const last = async (h: H, wa: string) => (await h.kinds(wa)).at(-1);

describe("S2 returning patient + reminder + reschedule", () => {
  it("books Monday morning, gets the 24h reminder, reschedules to the same day evening", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    await onboard(h);
    const acc = await accountId(h, PATIENT);
    await createProfile(h.ctx, acc, "Ramesh Kumar", "SELF");
    await createProfile(h.ctx, acc, "Sunita Devi", "MOTHER");

    await h.say(PATIENT, "Hi, need appointment Monday morning");
    expect(await last(h, PATIENT)).toBe("ASK_WHO");
    expect(h.lastText(PATIENT)).toContain("Welcome back, Ramesh ji");
    expect(h.buttons(PATIENT).map((b) => b.title)).toEqual(["For me", "Sunita", "Someone else"]);

    await h.tap(PATIENT, "who:me");
    expect(await last(h, PATIENT)).toBe("OFFER_NEAR_SLOTS");
    expect(h.buttons(PATIENT).map((b) => b.title).slice(0, 2)).toEqual(["10:00 AM", "10:20 AM"]);

    await h.say(PATIENT, "10:20");
    expect(await last(h, PATIENT)).toBe("ASK_VISIT_TYPE");
    await h.tap(PATIENT, "vt:FOLLOW_UP");
    await h.tap(PATIENT, "bk:yes"); // final confirmation
    expect(await last(h, PATIENT)).toBe("BOOKING_CONFIRMED");
    const appt = await h.db.appointment.findFirstOrThrow({ where: { status: "BOOKED" } });
    expect(appt.token).toBe("A-2");

    // Sunday 10:20 — outside the 24h window, so the approved template is used.
    await h.at("2026-10-11T10:20:00+05:30");
    expect(await last(h, PATIENT)).toBe("template:reminder_24h");
    const tpl = h.last(PATIENT);
    expect(tpl?.kind === "template" && tpl.quickReplyPayloads).toEqual([`appt:ok:${appt.id}`, `appt:rs:${appt.id}`, `appt:cx:${appt.id}`]);

    await h.tap(PATIENT, `appt:rs:${appt.id}`);
    expect(await last(h, PATIENT)).toBe("RS_ASK_WHEN");
    await h.say(PATIENT, "same day but evening");
    expect(await last(h, PATIENT)).toBe("OFFER_NEAR_SLOTS");
    const evening = h.buttons(PATIENT)[1]!;
    expect(evening.title).toBe("5:30 PM");
    await h.tap(PATIENT, evening.id);
    expect(await last(h, PATIENT)).toBe("RS_CONFIRM_ASK"); // nothing moves until confirmed
    expect(h.lastText(PATIENT)).toMatch(/From: .*10:20 AM[\s\S]*To: .*5:30 PM/);
    expect((await h.db.appointment.findUniqueOrThrow({ where: { id: appt.id } })).status).toBe("BOOKED");
    await h.tap(PATIENT, "bk:yes");
    expect(await last(h, PATIENT)).toBe("RS_DONE");
    expect(h.lastText(PATIENT)).toContain("10:20 AM slot is released");

    const old = await h.db.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    expect(old.status).toBe("CANCELLED");
    expect(old.slotKey).toBeNull();
    const moved = await h.db.appointment.findFirstOrThrow({ where: { status: "BOOKED" } });
    expect(moved.visitType).toBe("FOLLOW_UP");
    expect(moved.rescheduledFromId).toBe(appt.id);
    expect(await h.db.scheduledJob.count({ where: { key: `rday:${appt.id}`, doneAt: null } })).toBe(0);
  });
});

describe("S3 walk-in, quota full", () => {
  it("staff adjusts with a time; another declined; a third times out", async () => {
    h = await harness({ start: "2026-10-09T17:30:00+05:30" });
    await h.db.session.updateMany({ data: { walkinQuota: 0 } });
    const code = `WALKIN DRS-${await dailyCode(h.ctx)}`;

    await h.say(PATIENT2, code, "Anil");
    expect(await last(h, PATIENT2)).toBe("WELCOME_CONSENT");
    await h.tap(PATIENT2, "consent:yes");
    await h.tap(PATIENT2, "num:use");
    expect(await last(h, PATIENT2)).toBe("WALKIN_ASK_NAME");
    await h.say(PATIENT2, "Anil Verma");
    expect(await last(h, PATIENT2)).toBe("WALKIN_CHECKING");

    const staffMsg = h.last(SEED.staffPhone);
    expect(staffMsg?.kind).toBe("buttons");
    const yes = (staffMsg as { buttons: { id: string }[] }).buttons[0]!.id;
    await h.tap(SEED.staffPhone, yes);
    expect(h.lastText(SEED.staffPhone)).toContain("Which time should I give?");
    await h.say(SEED.staffPhone, "7:50 PM");
    expect(h.lastText(SEED.staffPhone)).toContain("Token issued");
    const k2 = await h.kinds(PATIENT2);
    expect(k2).toContain("WALKIN_ADJUSTED");
    // if they're already at the front, "you're next" follows the joining message — never before it
    if (k2.includes("YOU_ARE_NEXT")) expect(k2.indexOf("YOU_ARE_NEXT")).toBeGreaterThan(k2.indexOf("WALKIN_ADJUSTED"));
    expect(h.wa.to(PATIENT2).map((m) => JSON.stringify(m)).join(" ")).toMatch(/W-1.*7:50 PM/s);
    expect(h.lastText(SEED.doctorPhone)).toContain("handled by Priya");

    // Variant B: staff says No → booking slots offered + call clinic line
    const P3 = "919800000003";
    await h.say(P3, code, "Kiran"); await h.tap(P3, "consent:yes"); await h.tap(P3, "num:use"); await h.say(P3, "Kiran Rao");
    const req2 = await h.db.walkinOverflowRequest.findFirstOrThrow({ where: { status: "PENDING" } });
    await h.tap(SEED.staffPhone, `ovf:${req2.id}:no`);
    expect(await last(h, P3)).toBe("WALKIN_DECLINED");
    expect(h.lastText(P3)).toContain("call the clinic");
    expect(h.buttons(P3).length).toBe(3);

    // Variant C: nobody answers in 5 min → timeout; late staff reply is rejected politely
    const P4 = "919800000004";
    await h.say(P4, code, "Meena"); await h.tap(P4, "consent:yes"); await h.tap(P4, "num:use"); await h.say(P4, "Meena Shah");
    const req3 = await h.db.walkinOverflowRequest.findFirstOrThrow({ where: { status: "PENDING" } });
    await h.at("2026-10-09T17:36:00+05:30");
    expect(await last(h, P4)).toBe("WALKIN_TIMEOUT");
    await h.tap(SEED.staffPhone, `ovf:${req3.id}:yes`);
    expect(h.lastText(SEED.staffPhone)).toContain("Already handled");
  });

  it("rejects a wrong or old QR code", async () => {
    h = await harness({ start: "2026-10-09T17:30:00+05:30" });
    await h.say(PATIENT, "WALKIN DRS-ZZZZ");
    expect(await last(h, PATIENT)).toBe("WALKIN_BAD_CODE");
  });
});

describe("S4 queue status and alerts", () => {
  it("status in Hinglish, turn-near, running late, next, your turn", async () => {
    h = await harness({ start: "2026-10-09T17:30:00+05:30" });
    for (const n of ["Mohit", "Asha", "Ravi", "Neha"]) await h.say(SEED.staffPhone, `ADD ${n}`);
    const code = `WALKIN DRS-${await dailyCode(h.ctx)}`;
    await h.say(PATIENT, code, "Anil"); await h.tap(PATIENT, "consent:yes"); await h.tap(PATIENT, "num:use"); await h.say(PATIENT, "Anil Verma");
    expect(await last(h, PATIENT)).toBe("WALKIN_TOKEN");
    expect(h.lastText(PATIENT)).toContain("W-5");

    await h.say(PATIENT, "mera number kab aayega?");
    expect(await last(h, PATIENT)).toBe("STATUS");
    expect(h.lastText(PATIENT)).toContain("aapse pehle 4 patients");

    await h.say(SEED.staffPhone, "NEXT"); // W-1 in, W-2 next → 3 ahead
    expect(await last(h, PATIENT)).toBe("STATUS");
    await h.say(SEED.staffPhone, "NEXT"); // W-2 in, W-3 next, W-4 waiting → 2 ahead
    expect(await last(h, PATIENT)).toBe("TURN_NEAR");

    await h.say(SEED.doctorPhone, "LATE 15");
    expect(await last(h, PATIENT)).toBe("DOCTOR_LATE");
    expect(h.lastText(SEED.doctorPhone)).toMatch(/Informed \d+ patient/);

    await h.say(SEED.staffPhone, "NEXT"); // W-3 in, W-4 next
    await h.say(SEED.staffPhone, "NEXT"); // W-4 in, W-5 next
    expect(await last(h, PATIENT)).toBe("YOU_ARE_NEXT");
    await h.say(SEED.staffPhone, "NEXT"); // W-5 in
    expect(await last(h, PATIENT)).toBe("YOUR_TURN");
    const kinds = await h.kinds(PATIENT);
    expect(kinds.filter((k) => k === "TURN_NEAR")).toHaveLength(1);
  });
});

describe("S5 voice note, health details, emergency", () => {
  it("understands booking from voice, never stores health details, emergency reply", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    await onboard(h);
    await createProfile(h.ctx, await accountId(h, PATIENT), "Ramesh Kumar", "SELF");

    await h.voice(PATIENT, "kal subah appointment chahiye, bukhar hai teen din se");
    const k = await h.kinds(PATIENT);
    expect(k.slice(-3)).toEqual(["VOICE_UNDERSTOOD", "HEALTH_DETAILS_REDIRECT", "OFFER_NEAR_SLOTS"]);
    expect(h.buttons(PATIENT).map((b) => b.title).slice(0, 2)).toEqual(["10:00 AM", "10:20 AM"]);

    await h.say(PATIENT, "I have fever since 3 days and my sugar is high, which one is better?");
    expect((await h.kinds(PATIENT)).slice(-2)).toEqual(["HEALTH_DETAILS_REDIRECT", "OFFER_NEAR_SLOTS"]);

    await h.image(PATIENT);
    expect((await h.kinds(PATIENT)).slice(-2)).toEqual(["MEDIA_REPORTS", "RESUME_PROMPT"]);
    expect(h.wa.mediaDownloads).toHaveLength(1); // only the voice note, never the image

    await h.say(PATIENT, "papa ko chest pain ho raha hai abhi");
    expect((await h.kinds(PATIENT)).slice(-2)).toEqual(["EMERGENCY_REPLY", "CLINIC_CONTACT"]);
    expect(h.wa.sent.at(-2)?.msg.kind === "text" && (h.wa.sent.at(-2)!.msg as { body: string }).body).toContain("108");
  });
});

describe("S6 slot race and family same slot", () => {
  it("race lost → alternatives → declined → call clinic; family member offered the next slot", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    await onboard(h);
    const acc = await accountId(h, PATIENT);
    await createProfile(h.ctx, acc, "Ramesh Kumar", "SELF");
    await h.say(PATIENT, "tomorrow evening around 6 for me");
    expect(h.buttons(PATIENT).map((b) => b.title).slice(0, 2)).toEqual(["5:50 PM", "6:10 PM"]);
    const six10 = h.buttons(PATIENT)[1]!.id;

    // Another patient takes 6:10 a second earlier.
    await onboard(h, PATIENT2, "Vikas");
    await createProfile(h.ctx, await accountId(h, PATIENT2), "Vikas Jain", "SELF");
    await h.say(PATIENT2, "book tomorrow 6:10 pm for me");
    await h.tap(PATIENT2, "vt:NEW");
    await h.tap(PATIENT2, "bk:yes"); // final confirmation
    expect(await last(h, PATIENT2)).toBe("BOOKING_CONFIRMED");

    await h.tap(PATIENT, six10);
    expect(await last(h, PATIENT)).toBe("SLOT_RACE_LOST");
    expect(h.buttons(PATIENT).map((b) => b.title).slice(0, 2)).toEqual(["5:50 PM", "6:30 PM"]);

    await h.say(PATIENT, "no, I need 6 pm only");
    expect(await last(h, PATIENT)).toBe("SLOT_RACE_DECLINED");
    await h.tap(PATIENT, "call");
    expect((await h.kinds(PATIENT)).slice(-2)).toEqual(["CALL_CLINIC", "CLINIC_CONTACT"]);

    // Ramesh books 6:30 for himself, then asks for his son at the same time.
    await h.say(PATIENT, "book tomorrow 6:30 pm for me");
    await h.tap(PATIENT, "vt:NEW");
    await h.tap(PATIENT, "bk:yes"); // final confirmation
    expect(await last(h, PATIENT)).toBe("BOOKING_CONFIRMED");
    await h.say(PATIENT, "also book for my son Aarav tomorrow at 6:30 PM");
    expect(await last(h, PATIENT)).toBe("SAME_SLOT_FAMILY");
    expect(h.lastText(PATIENT)).toContain("Ramesh ji");
    expect(h.buttons(PATIENT)[0]!.title).toBe("Book 6:50 PM");
    await h.tap(PATIENT, h.buttons(PATIENT)[0]!.id);
    await h.tap(PATIENT, "vt:NEW");
    await h.tap(PATIENT, "bk:yes"); // final confirmation
    expect(await last(h, PATIENT)).toBe("BOOKING_CONFIRMED");
    expect(h.lastText(PATIENT)).toContain("Aarav ji");
    expect(await h.db.appointment.count({ where: { status: "BOOKED" } })).toBe(3);
  });
});
