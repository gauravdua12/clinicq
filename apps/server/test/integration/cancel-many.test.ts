import { afterEach, describe, expect, it } from "vitest";
import { slots as S, time as T } from "@clinicq/core";
import type { OutMsg } from "@clinicq/wa";
import { harness, onboard, PATIENT, type H } from "../harness";
import { confirmHold, holdSlot } from "../../src/services/booking";
import { clinicInfo, windowAvailability } from "../../src/services/clinic";
import { createProfile } from "../../src/services/patients";

// Cancelling when a patient has several bookings: all of them are listed (numbered), and one, several or all can be
// cancelled, by tapping or by typing their numbers. A single booking still goes straight to its confirmation.

let h: H;
afterEach(async () => h?.close());

const body = (m?: OutMsg) => (m && "body" in m ? m.body : "");
const active = () => h.db.appointment.count({ where: { status: "BOOKED" } });

/** Ramesh (self), his mother and his son, each booked once: Sat 10 Oct 10:00, Sat 10 Oct 6:10 PM, Mon 12 Oct 10:20. */
async function threeBookings(): Promise<string[]> {
  h = await harness({ start: "2026-10-09T12:00:00+05:30" });
  await onboard(h);
  const acc = await h.db.patientAccount.findFirstOrThrow();
  const people = [await createProfile(h.ctx, acc.id, "Ramesh Kumar", "SELF"), await createProfile(h.ctx, acc.id, "Sunita Devi", "MOTHER"), await createProfile(h.ctx, acc.id, "Aarav Kumar", "SON")];
  const av = await windowAvailability(h.ctx, await clinicInfo(h.ctx));
  const ids: string[] = [];
  for (const [i, [date, time]] of ([["2026-10-10", "10:00"], ["2026-10-10", "18:10"], ["2026-10-12", "10:20"]] as const).entries()) {
    const held = await holdSlot(h.ctx, S.findSlot(date, T.toMin(time), av)!, people[i]!.id, acc.id);
    ids.push((await confirmHold(h.ctx, held.id, "NEW", "STAFF")).id);
  }
  return ids;
}

describe("cancelling one, several or all appointments", () => {
  it("'cancel' lists every upcoming appointment, numbered, with 'All of these'", async () => {
    await threeBookings();
    await h.say(PATIENT, "cancel my appointment");
    const m = h.wa.last(PATIENT);
    expect(m?.kind).toBe("list");
    expect(body(m)).toMatch(/1\. Ramesh – Sat 10 Oct 10:00 AM.*\n2\. Sunita – Sat 10 Oct 6:10 PM.*\n3\. Aarav – Mon 12 Oct 10:20 AM/);
    expect(body(m)).toMatch(/type their numbers, like "1 and 3"/);
    const rows = m?.kind === "list" ? m.sections.flatMap((x) => x.rows) : [];
    expect(rows.map((r) => r.title)).toEqual(["1. Sat 10 Oct, 10:00 AM", "2. Sat 10 Oct, 6:10 PM", "3. Mon 12 Oct, 10:20 AM", "All of these (3)"]);
    expect(rows[1]!.description).toMatch(/^Sunita/);
  });

  it("All of these → one confirmation → all cancelled", async () => {
    await threeBookings();
    await h.say(PATIENT, "cancel");
    await h.tap(PATIENT, "cxp:all");
    expect(body(h.wa.last(PATIENT))).toMatch(/^Cancel these 3 appointments\?/);
    expect(h.buttons(PATIENT).map((b) => b.id)).toEqual(["cx:many", "cx:no"]);
    await h.tap(PATIENT, "cx:many");
    expect(await active()).toBe(0);
    expect((await h.kinds(PATIENT)).at(-1)).toBe("CX_DONE_MANY");
    expect(body(h.wa.last(PATIENT))).toMatch(/^Cancelled 3 appointments ✅/);
  });

  it("one from the list, then 'Cancel another' for the next, then 'that's all'", async () => {
    const ids = await threeBookings();
    await h.say(PATIENT, "appointment cancel karna hai");
    await h.tap(PATIENT, `cxp:${ids[1]}`);
    expect((await h.kinds(PATIENT)).at(-1)).toBe("CX_CONFIRM");
    await h.tap(PATIENT, `cx:yes:${ids[1]}`);
    expect(await active()).toBe(2);
    const done = h.wa.last(PATIENT);
    expect(body(done)).toMatch(/Ramesh – Sat 10 Oct 10:00 AM\n• Aarav – Mon 12 Oct 10:20 AM/);
    expect(h.buttons(PATIENT).map((b) => b.id)).toEqual(["cx:more", "cx:done"]);
    await h.tap(PATIENT, "cx:more");
    expect(h.wa.last(PATIENT)?.kind).toBe("list"); // the two that are left
    await h.tap(PATIENT, `cxp:${ids[2]}`);
    await h.tap(PATIENT, `cx:yes:${ids[2]}`);
    expect(await active()).toBe(1);
    await h.tap(PATIENT, "cx:done");
    expect((await h.kinds(PATIENT)).at(-1)).toBe("CX_REST_KEPT");
    expect(await active()).toBe(1);
  });

  it("typed numbers pick several: '1 and 3' → confirm both → 'yes'", async () => {
    const ids = await threeBookings();
    await h.say(PATIENT, "cancel my appointments");
    await h.say(PATIENT, "1 and 3");
    expect(body(h.wa.last(PATIENT))).toMatch(/^Cancel these 2 appointments\?\n• Ramesh – Sat 10 Oct 10:00 AM\n• Aarav – Mon 12 Oct 10:20 AM$/);
    await h.say(PATIENT, "yes");
    const left = await h.db.appointment.findMany({ where: { status: "BOOKED" } });
    expect(left.map((a) => a.id)).toEqual([ids[1]]);
    expect(body(h.wa.last(PATIENT))).toMatch(/^Cancelled 2 appointments ✅ You still have:\n• Sunita/);
  });

  it("typed 'dono'/'all' picks all; 'no' at the confirmation keeps them", async () => {
    await threeBookings();
    await h.say(PATIENT, "cancel");
    await h.say(PATIENT, "all");
    expect(body(h.wa.last(PATIENT))).toMatch(/^Cancel these 3 appointments\?/);
    await h.say(PATIENT, "no");
    expect((await h.kinds(PATIENT)).at(-1)).toBe("CX_KEPT_MANY");
    expect(await active()).toBe(3);
  });

  it("a typed single number confirms that one; a number not in the list is not taken as a pick", async () => {
    const ids = await threeBookings();
    await h.say(PATIENT, "cancel");
    await h.say(PATIENT, "7");
    expect((await h.kinds(PATIENT)).at(-1)).not.toBe("CX_CONFIRM");
    expect(await active()).toBe(3);
    await h.say(PATIENT, "cancel");
    await h.say(PATIENT, "2");
    expect(body(h.wa.last(PATIENT))).toMatch(/^Cancel Sunita ji's appointment on Sat 10 Oct at 6:10 PM\?/);
    await h.tap(PATIENT, `cx:yes:${ids[1]}`);
    expect(await active()).toBe(2);
  });

  it("'cancel all my appointments' / 'mere saare appointments cancel kar do' → one confirmation for all", async () => {
    await threeBookings();
    await h.say(PATIENT, "mere saare appointments cancel kar do");
    expect((await h.kinds(PATIENT)).at(-1)).toBe("CX_CONFIRM_MANY");
    expect(body(h.wa.last(PATIENT))).toMatch(/3 appointments/);
    await h.tap(PATIENT, "cx:no");
    await h.say(PATIENT, "cancel all my appointments");
    expect(body(h.wa.last(PATIENT))).toMatch(/^Cancel these 3 appointments\?/);
  });

  it("one person's booking named, then 'dono' / 'both': all of them", async () => {
    await threeBookings();
    await h.say(PATIENT, "cancel mummy ka appointment");
    expect(body(h.wa.last(PATIENT))).toMatch(/Sunita ji/);
    await h.say(PATIENT, "dono");
    expect((await h.kinds(PATIENT)).at(-1)).toBe("CX_CONFIRM_MANY");
    expect(await active()).toBe(3); // nothing cancelled before the confirmation
    await h.say(PATIENT, "dono");
    expect(await active()).toBe(0); // "both" to "cancel these 3?" is a yes
  });

  it("'nahi, dono rehne do' at the confirmation keeps them", async () => {
    await threeBookings();
    await h.say(PATIENT, "cancel all my appointments");
    await h.say(PATIENT, "nahi, dono rehne do");
    expect(await active()).toBe(3);
  });

  it("the Cancel button on a confirmation or reminder also lists all bookings when there are several", async () => {
    const ids = await threeBookings();
    await h.tap(PATIENT, `appt:cx:${ids[0]}`);
    expect(h.wa.last(PATIENT)?.kind).toBe("list");
    expect((await h.kinds(PATIENT)).at(-1)).toBe("CX_PICK_APPT");
  });

  it("with a single booking, cancel goes straight to its confirmation (unchanged)", async () => {
    h = await harness({ start: "2026-10-09T12:00:00+05:30" });
    await onboard(h);
    const acc = await h.db.patientAccount.findFirstOrThrow();
    const me = await createProfile(h.ctx, acc.id, "Ramesh Kumar", "SELF");
    const av = await windowAvailability(h.ctx, await clinicInfo(h.ctx));
    const held = await holdSlot(h.ctx, S.findSlot("2026-10-10", T.toMin("10:00"), av)!, me.id, acc.id);
    const appt = await confirmHold(h.ctx, held.id, "NEW", "STAFF");
    await h.tap(PATIENT, `appt:cx:${appt.id}`);
    expect((await h.kinds(PATIENT)).at(-1)).toBe("CX_CONFIRM");
    await h.tap(PATIENT, `cx:yes:${appt.id}`);
    expect((await h.kinds(PATIENT)).at(-1)).toBe("CX_DONE");
  });

  it("Hindi: the list and buttons are in Hindi and fit WhatsApp's limits", async () => {
    await threeBookings();
    await h.tap(PATIENT, "lang:hi");
    await h.say(PATIENT, "अपॉइंटमेंट कैंसल करना है");
    const m = h.wa.last(PATIENT);
    expect(m?.kind === "list" && m.button).toBe("चुनें");
    await h.tap(PATIENT, "cxp:all");
    expect(h.buttons(PATIENT).map((b) => b.title)).toEqual(["हाँ, सब कैंसल करें", "रहने दें"]);
  });
});
