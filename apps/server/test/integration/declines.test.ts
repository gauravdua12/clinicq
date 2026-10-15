import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { phoneHash } from "@clinicq/db";
import type { OutMsg } from "@clinicq/wa";
import { harness, onboard, type H } from "../harness";

// "I don't want to book", "bye", "close the chat", "wrong number", "nahi chahiye"… in every state: the patient gets a
// reply that fits (stopped / kept / nothing saved / sorry), never the menu or the next booking question, nothing is
// booked or cancelled by mistake, and "close the chat" is not an unsubscribe.

let h: H;
let n = 0;
const nextPhone = () => `9196${String(++n).padStart(8, "0")}`;
const body = (m?: OutMsg) => (m && "body" in m ? m.body : "");
const WHEN = ["Monday morning", "Monday evening", "Tuesday morning", "Tuesday evening", "Wednesday morning", "Wednesday evening", "Thursday morning", "Thursday evening"];
let w = 0;

beforeEach(async () => { h = await harness({ start: "2026-10-09T12:00:00+05:30" }); w = 0; });
afterEach(async () => h?.close());

const acc = (P: string) => h.db.patientAccount.findUnique({ where: { phoneHash: phoneHash(P) } });
async function state(P: string): Promise<string> {
  const a = await acc(P);
  return (a && (await h.db.conversationState.findUnique({ where: { accountId: a.id } }))?.state) ?? "NONE";
}
const mine = (P: string, status: string) => h.db.appointment.count({ where: { status: status as never, profile: { account: { phoneHash: phoneHash(P) } } } });

async function pickTime(P: string): Promise<void> {
  await onboard(h, P);
  await h.say(P, `book ${WHEN[w++ % WHEN.length]} for me`);
  await h.tap(P, "who:me");
}
async function booked(P: string): Promise<void> {
  await pickTime(P); await h.tap(P, h.buttons(P)[0]!.id); await h.tap(P, "vt:NEW"); await h.tap(P, "bk:yes");
}

type Kind = "noConsent" | "closed" | "booking" | "keepAppt" | "keepData";
const SETUPS: [string, string, Kind, (P: string) => Promise<void>][] = [
  ["consent pending", "AWAIT_CONSENT", "noConsent", async (P) => { await h.say(P, "Hi"); }],
  ["number confirmation", "AWAIT_NUMBER_CONFIRM", "closed", async (P) => { await h.say(P, "Hi"); await h.tap(P, "consent:yes"); }],
  ["main menu", "IDLE", "closed", async (P) => { await onboard(h, P); }],
  ["after a booking", "IDLE", "closed", booked],
  ["who is it for", "BK_WHO", "booking", async (P) => { await onboard(h, P); await h.tap(P, "menu:book"); }],
  ["patient's name", "BK_NAME", "booking", async (P) => { await onboard(h, P); await h.tap(P, "menu:book"); await h.tap(P, "who:other"); }],
  ["booking page sent", "BK_FLOW_OPEN", "booking", async (P) => { await onboard(h, P); await h.tap(P, "menu:book"); await h.tap(P, "who:me"); }],
  ["choosing a time", "BK_PICK_SLOT", "booking", pickTime],
  ["visit type", "BK_VISIT_TYPE", "booking", async (P) => { await pickTime(P); await h.tap(P, h.buttons(P)[0]!.id); }],
  ["final confirmation", "BK_CONFIRM", "booking", async (P) => { await pickTime(P); await h.tap(P, h.buttons(P)[0]!.id); await h.tap(P, "vt:NEW"); }],
  ["reschedule: which day", "BK_WHEN", "booking", async (P) => {
    await booked(P);
    const a = await h.db.appointment.findFirstOrThrow({ where: { status: "BOOKED", profile: { account: { phoneHash: phoneHash(P) } } } });
    await h.tap(P, `appt:rs:${a.id}`);
  }],
  ["cancel confirmation", "CX_CONFIRM", "keepAppt", async (P) => { await booked(P); await h.say(P, "cancel my appointment"); }],
  ["which appointment to cancel", "CX_PICK_APPT", "keepAppt", async (P) => {
    await booked(P); await h.say(P, `book ${WHEN[w++ % WHEN.length]} for me`); await h.tap(P, h.buttons(P)[0]!.id); await h.tap(P, "vt:NEW"); await h.tap(P, "bk:yes");
    await h.say(P, "cancel my appointment");
  }],
  ["delete data confirmation", "ERASE_CONFIRM", "keepData", async (P) => { await onboard(h, P); await h.say(P, "delete my data"); }],
];

const DECLINES = [
  "I don't want to book", "I dont want any appointment", "no booking needed", "no thanks", "nothing", "never mind", "I changed my mind",
  "bye", "ok bye", "thank you, that's all", "close this chat", "end the chat", "stop the booking", "leave it", "forget it",
  "wrong number", "sorry, messaged by mistake", "I'll call the clinic instead",
  "mujhe appointment nahi chahiye", "nahi chahiye", "kuch nahi", "rehne do", "bas", "booking mat karo", "मुझे अपॉइंटमेंट नहीं चाहिए", "कुछ नहीं",
];
const WRONG = /wrong number|by mistake/i, CALL = /call the clinic/i;
const EXPECT: Record<Kind, string[]> = {
  noConsent: ["CLOSED_NO_CONSENT"], closed: ["CHAT_CLOSED"], booking: ["BOOKING_STOPPED"], keepAppt: ["CX_KEPT", "CX_KEPT_MANY"], keepData: ["ERASE_KEPT"],
};

describe("declining or leaving, in every state", () => {
  for (const [label, expected, kind, setup] of SETUPS) {
    it(`${label}: a fitting close, no menu, nothing booked or cancelled by mistake`, async () => {
      for (const text of DECLINES) {
        const P = nextPhone();
        await setup(P);
        expect(await state(P), `${label} setup`).toBe(expected);
        const bookedBefore = await mine(P, "BOOKED");
        const before = h.wa.to(P).length;
        await h.say(P, text);
        const out = h.wa.to(P).slice(before);
        const kinds = (await h.kinds(P)).slice(-out.length);
        const where = `${label} ← "${text}": ${kinds.join("+")} «${out.map(body).join(" / ")}»`;
        const special = kind === "keepAppt" || kind === "keepData" ? null : WRONG.test(text) ? "WRONG_NUMBER" : CALL.test(text) ? "CALL_CLINIC" : null;
        expect(kinds[0], where).toBe(special ?? kinds[0]);
        if (!special) expect(EXPECT[kind], where).toContain(kinds[0]);
        // never the menu or a booking question
        for (const m of out) if (m.kind === "buttons" || m.kind === "list") expect(m.kind, where).toBe("none");
        expect(kinds, where).not.toContain("SYSTEM_ERROR");
        expect((await acc(P))?.optedOutAt ?? null, where).toBeNull(); // closing the chat is not an unsubscribe
        if (kind !== "keepData") expect(await state(P), where).toBe("IDLE");
        expect(await mine(P, "HELD"), where).toBe(0); // a held slot is released
        expect(await mine(P, "BOOKED"), where).toBe(bookedBefore); // nothing booked or cancelled
        if (kind === "noConsent") expect(await h.db.consentRecord.count({ where: { account: { phoneHash: phoneHash(P) } } }), where).toBe(0);
        if (kind === "keepData") expect(await acc(P), where).not.toBeNull();
        // and then "ok" / "thanks" closes politely too
        await h.say(P, "ok");
        const k2 = (await h.kinds(P)).at(-1);
        expect(["ACK_CLOSING", "THANKS_REPLY", "CONSENT_REMINDER", "CONFIRM_NUMBER", "MAIN_MENU"], `${where} → then "ok": ${k2}`).toContain(k2);
      }
    }, 90_000);
  }
});

describe("plain 'no' and 'ok' fit the question that was asked", () => {
  it("'no' after the menu closes; 'ok' after the menu nudges without repeating it", async () => {
    const P = nextPhone(); await onboard(h, P);
    await h.say(P, "no");
    expect((await h.kinds(P)).at(-1)).toBe("CHAT_CLOSED");
    const Q = nextPhone(); await onboard(h, Q);
    await h.say(Q, "ok");
    expect((await h.kinds(Q)).at(-1)).toBe("MENU_NUDGE");
    expect(h.wa.last(Q)?.kind).toBe("text");
  });
  it("'no' to the offered times or the final confirmation: other times, or stop", async () => {
    const P = nextPhone(); await pickTime(P);
    await h.say(P, "no");
    expect((await h.kinds(P)).at(-1)).toBe("OTHER_TIMES_OR_STOP");
    expect(h.buttons(P).map((b) => b.id)).toEqual(["see_all", "bk:stop"]);
    await h.tap(P, "bk:stop");
    expect((await h.kinds(P)).at(-1)).toBe("BOOKING_STOPPED");
    expect(await mine(P, "HELD")).toBe(0);
    const Q = nextPhone(); await pickTime(Q); await h.tap(Q, h.buttons(Q)[0]!.id); await h.tap(Q, "vt:NEW");
    await h.say(Q, "no");
    expect((await h.kinds(Q)).at(-1)).toBe("OTHER_TIMES_OR_STOP");
  });
  it("'no' to 'who is it for?' or the visit type stops the booking", async () => {
    const P = nextPhone(); await onboard(h, P); await h.tap(P, "menu:book");
    await h.say(P, "no");
    expect((await h.kinds(P)).at(-1)).toBe("BOOKING_STOPPED");
    const Q = nextPhone(); await pickTime(Q); await h.tap(Q, h.buttons(Q)[0]!.id);
    await h.say(Q, "no");
    expect((await h.kinds(Q)).at(-1)).toBe("BOOKING_STOPPED");
    expect(await mine(Q, "HELD")).toBe(0);
  });
  it("'no' to 'use this number?' still asks for another number", async () => {
    const P = nextPhone(); await h.say(P, "Hi"); await h.tap(P, "consent:yes");
    await h.say(P, "no");
    expect((await h.kinds(P)).at(-1)).toBe("ASK_ALT_NUMBER");
  });
});

describe("messages that sound negative but ask for something are still understood", () => {
  it("'not Monday, book Tuesday evening' and 'not for me, for my mother' carry on", async () => {
    const P = nextPhone(); await pickTime(P);
    await h.say(P, "I don't want Monday, book Tuesday evening");
    expect(["OFFER_NEAR_SLOTS", "LIST_PICKER", "BOOK_LINK"]).toContain((await h.kinds(P)).at(-1));
    const Q = nextPhone(); await onboard(h, Q); await h.tap(Q, "menu:book");
    await h.say(Q, "not for me, for my mother Sunita");
    expect((await h.kinds(Q)).at(-1)).not.toBe("BOOKING_STOPPED");
  });
  it("'I don't want my appointment' cancels the booking they have (with confirmation)", async () => {
    const P = nextPhone(); await booked(P);
    await h.say(P, "I don't want my appointment");
    expect((await h.kinds(P)).at(-1)).toBe("CX_CONFIRM");
    expect(await mine(P, "BOOKED")).toBe(1);
  });
  it("a bare 'stop' is still an unsubscribe; 'not now' mid-booking keeps the place", async () => {
    const P = nextPhone(); await onboard(h, P);
    await h.say(P, "stop");
    expect((await h.kinds(P)).at(-1)).toBe("OPTED_OUT");
    const Q = nextPhone(); await pickTime(Q);
    await h.say(Q, "not now");
    expect((await h.kinds(Q)).at(-1)).toBe("WAIT_OK");
    expect(await state(Q)).toBe("BK_PICK_SLOT");
  });
  it("'wrong number' as the very first message: a short apology, no consent request", async () => {
    const P = nextPhone();
    await h.say(P, "sorry wrong number");
    expect(await h.kinds(P)).toEqual(["WRONG_NUMBER"]);
  });
  it("after closing, 'hi' brings the menu back", async () => {
    const P = nextPhone(); await onboard(h, P);
    await h.say(P, "bye");
    await h.say(P, "hi");
    expect((await h.kinds(P)).at(-1)).toBe("MAIN_MENU");
  });
});
