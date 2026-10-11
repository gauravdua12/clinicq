import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { harness, PATIENT, type H } from "../harness";

// S1 — New patient booking (docs/CONVERSATION_GUIDE.md §7). Today: Fri 9 Oct 2026, 12:00 IST.
describe("S1 new patient booking", () => {
  let h: H;
  beforeAll(async () => { h = await harness({ start: "2026-10-09T12:00:00+05:30" }); });
  afterAll(async () => h.close());

  it("consent → number → who → when → near slots → visit type → confirmed", async () => {
    await h.say(PATIENT, "Hi, I want to book appointment");
    expect(await h.kinds(PATIENT)).toEqual(["WELCOME_CONSENT"]);
    expect(h.buttons(PATIENT).map((b) => b.id)).toEqual(["consent:yes"]);

    await h.tap(PATIENT, "consent:yes");
    expect((await h.kinds(PATIENT)).at(-1)).toBe("CONFIRM_NUMBER");
    expect(h.lastText(PATIENT)).toContain("+91 98765 43210");
    expect(h.buttons(PATIENT).map((b) => b.title)).toEqual(["Use +91 98765 43210", "Different number"]);

    await h.tap(PATIENT, "num:use");
    expect((await h.kinds(PATIENT)).at(-1)).toBe("ASK_WHO");

    await h.say(PATIENT, "for my mother, Sunita");
    expect((await h.kinds(PATIENT)).slice(-2)).toEqual(["ACK_PROFILE", "ASK_WHEN"]);

    await h.say(PATIENT, "kal shaam 6 baje ke aas paas");
    expect((await h.kinds(PATIENT)).at(-1)).toBe("OFFER_NEAR_SLOTS");
    expect(h.buttons(PATIENT).map((b) => b.title)).toEqual(["5:50 PM", "6:10 PM", "Saare slots dekhein"]);
    expect(h.lastText(PATIENT)).toMatch(/kal/i);

    const slot = h.buttons(PATIENT)[1]!.id;
    await h.tap(PATIENT, slot);
    expect((await h.kinds(PATIENT)).at(-1)).toBe("ASK_VISIT_TYPE");

    await h.tap(PATIENT, "vt:NEW");
    expect((await h.kinds(PATIENT)).at(-1)).toBe("BOOKING_CONFIRMED");
    expect(h.lastText(PATIENT)).toMatch(/Sunita ji/);
    expect(h.lastText(PATIENT)).toMatch(/Token \*A-4\*/);

    const appts = await h.db.appointment.findMany({ where: { status: "BOOKED" } });
    expect(appts).toHaveLength(1);
    expect(appts[0]!.visitType).toBe("NEW");
    expect(appts[0]!.slotKey).toBeTruthy();
    expect(await h.db.consentRecord.count()).toBe(1);
    expect(await h.db.scheduledJob.count({ where: { key: { startsWith: "r24:" } } })).toBe(1); // Sat 18:10 is 30h away → T-24h reminder
    expect(await h.db.scheduledJob.count({ where: { key: { startsWith: "rday:" } } })).toBe(1);
  });
});
