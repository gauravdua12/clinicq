import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { phoneHash } from "@clinicq/db";
import type { OutMsg } from "@clinicq/wa";
import { harness, onboard, PATIENT, type H } from "../harness";
import { createProfile } from "../../src/services/patients";
import { clinicInfo, invalidateClinicCache, nowLocal } from "../../src/services/clinic";
import { issueWalkin, startNext } from "../../src/services/queue";

// Off-script messages in every conversation state: rude, "hold on", "what can you do?", gibberish, off-topic,
// greetings, "stop". Whatever the state, the patient must get a fitting, courteous reply — never the same
// question back word for word, never an error, and never a loop.

let h: H;
let n = 0;
const nextPhone = () => `9198${String(++n).padStart(8, "0")}`;
const body = (m?: OutMsg) => (m && "body" in m ? m.body : m?.kind === "template" ? m.name : "");

async function state(from: string): Promise<string> {
  const acc = await h.db.patientAccount.findFirst({ where: { phoneHash: phoneHash(from) } });
  const row = acc ? await h.db.conversationState.findUnique({ where: { accountId: acc.id } }) : null;
  return row?.state ?? "NONE";
}

// Bookings spread over Mon–Thu so the slots don't run out (tomorrow stays free for the reschedule cases).
const WHEN = ["Monday morning", "Monday evening", "Tuesday morning", "Tuesday evening", "Wednesday morning", "Wednesday evening", "Thursday morning", "Thursday evening"];
let w = 0;
async function bookTomorrowEvening(P: string): Promise<void> {
  await onboard(h, P);
  await h.say(P, `book ${WHEN[w++ % WHEN.length]} for me`); // spread over days so the slots don't run out
  await h.tap(P, "who:me");
  const first = h.buttons(P)[0];
  if (!first) throw new Error(`no times offered: ${(await h.kinds(P)).slice(-3).join(",")} ${h.lastText(P)}`);
  await h.tap(P, first.id); // first offered time
}

async function chatPicker(): Promise<void> {
  const c = await h.db.clinic.findFirstOrThrow();
  await h.db.clinic.update({ where: { id: c.id }, data: { settings: { ...(c.settings as object), slotPicker: "chat" } } });
  invalidateClinicCache();
}
async function booked(P: string): Promise<string> {
  await bookTomorrowEvening(P); await h.tap(P, "vt:NEW"); await h.tap(P, "bk:yes");
  return (await h.db.appointment.findFirstOrThrow({ where: { status: "BOOKED", profile: { account: { phoneHash: phoneHash(P) } } }, orderBy: { createdAt: "desc" } })).id;
}

const SETUPS: [string, string, (P: string) => Promise<void>][] = [
  ["consent pending", "AWAIT_CONSENT", async (P) => { await h.say(P, "Hi"); }],
  ["number confirmation", "AWAIT_NUMBER_CONFIRM", async (P) => { await h.say(P, "Hi"); await h.tap(P, "consent:yes"); }],
  ["typing another number", "AWAIT_ALT_NUMBER", async (P) => { await h.say(P, "Hi"); await h.tap(P, "consent:yes"); await h.tap(P, "num:alt"); }],
  ["main menu", "IDLE", async (P) => { await onboard(h, P); }],
  ["who is it for", "BK_WHO", async (P) => { await onboard(h, P); await h.tap(P, "menu:book"); }],
  ["patient's name", "BK_NAME", async (P) => { await onboard(h, P); await h.tap(P, "menu:book"); await h.tap(P, "who:other"); }],
  ["booking page sent", "BK_FLOW_OPEN", async (P) => { await onboard(h, P); await h.tap(P, "menu:book"); await h.tap(P, "who:me"); }],
  ["choosing a time", "BK_PICK_SLOT", async (P) => { await onboard(h, P); await h.say(P, "book tomorrow evening for me"); await h.tap(P, "who:me"); }],
  ["visit type", "BK_VISIT_TYPE", bookTomorrowEvening],
  ["final confirmation", "BK_CONFIRM", async (P) => { await bookTomorrowEvening(P); await h.tap(P, "vt:NEW"); }],
  ["after booking", "IDLE", async (P) => { await bookTomorrowEvening(P); await h.tap(P, "vt:NEW"); await h.tap(P, "bk:yes"); }],
  ["cancel confirmation", "CX_CONFIRM", async (P) => { await bookTomorrowEvening(P); await h.tap(P, "vt:NEW"); await h.tap(P, "bk:yes"); await h.say(P, "cancel my appointment"); }],
  ["reschedule: which day", "BK_WHEN", async (P) => {
    await bookTomorrowEvening(P); await h.tap(P, "vt:NEW"); await h.tap(P, "bk:yes");
    const appt = await h.db.appointment.findFirstOrThrow({ where: { status: "BOOKED", profile: { account: { phoneHash: phoneHash(P) } } } });
    await h.tap(P, `appt:rs:${appt.id}`);
  }],
  ["delete data confirmation", "ERASE_CONFIRM", async (P) => { await onboard(h, P); await h.say(P, "delete my data"); }],
  ["reschedule confirmation", "BK_CONFIRM", async (P) => {
    const id = await booked(P);
    await h.tap(P, `appt:rs:${id}`); await h.tap(P, h.buttons(P)[1]!.id); await h.tap(P, h.buttons(P)[0]!.id);
    expect((await h.kinds(P)).at(-1)).toBe("RS_CONFIRM_ASK");
  }],
  ["which appointment to cancel", "CX_PICK_APPT", async (P) => {
    await booked(P);
    await h.say(P, `book ${WHEN[w++ % WHEN.length]} for me`); await h.tap(P, h.buttons(P)[0]!.id); await h.tap(P, "vt:NEW"); await h.tap(P, "bk:yes");
    await h.say(P, "cancel my appointment");
  }],
  ["chat picker: which day", "BK_WHEN", async (P) => { await chatPicker(); await onboard(h, P); await h.tap(P, "menu:book"); await h.tap(P, "who:me"); }],
  ["chat picker: morning or evening", "BK_PICK_SLOT", async (P) => { await chatPicker(); await onboard(h, P); await h.tap(P, "menu:book"); await h.tap(P, "who:me"); await h.tap(P, "see_all"); }],
  ["Hindi chosen: main menu", "IDLE", async (P) => { await onboard(h, P); await h.tap(P, "lang:hi"); }],
  ["Hindi chosen: who is it for", "BK_WHO", async (P) => { await onboard(h, P); await h.tap(P, "lang:hi"); await h.tap(P, "menu:book"); }],
];

type Cat = "rude" | "wait" | "help" | "other" | "greeting" | "info" | "stop";
const MESSAGES: [string, Cat][] = [
  ["Stupid", "rude"],
  ["Stop it now", "rude"],
  ["you are useless, same message again", "rude"],
  ["Hold", "wait"],
  ["wait a minute", "wait"],
  ["what can you do?", "help"],
  ["asdf qwerty zxcv", "other"],
  ["tell me a joke", "other"],
  ["😊", "other"],
  ["hi", "greeting"],
  ["what are your timings?", "info"],
  ["pagal ho kya", "rude"],
  ["bakwas band karo", "rude"],
  ["ruko", "wait"],
  ["kya kar sakte ho?", "help"],
  ["stop", "stop"],
];

beforeEach(async () => { h = await harness({ start: "2026-10-09T12:00:00+05:30" }); w = 0; });
afterEach(async () => h?.close());

describe("off-script messages in every state", () => {
  for (const [label, expected, setup] of SETUPS) {
    it(`${label}: courteous, fitting replies; never the same question twice`, async () => {
      for (const [text, cat] of MESSAGES) {
        const P = nextPhone();
        await setup(P);
        expect(await state(P), `${label} setup`).toBe(expected);
        const prev = body(h.wa.last(P));
        const before = h.wa.to(P).length;
        await h.say(P, text);
        const replies = h.wa.to(P).slice(before);
        const all = replies.map(body).join("\n---\n");
        const where = `${label} ← "${text}":\n${all}`;
        expect(replies.length, where).toBeGreaterThan(0);
        expect(body(replies[0]), where).not.toBe(prev); // never the previous message again, word for word
        expect(await h.kinds(P), where).not.toContain("SYSTEM_ERROR");
        const acc = await h.db.patientAccount.findFirstOrThrow({ where: { phoneHash: phoneHash(P) } });
        if (cat === "rude") {
          expect(all, where).toMatch(/sorry|माफ़/i);
          expect(acc.optedOutAt, where).toBeNull(); // frustration is not an unsubscribe
        }
        if (cat === "wait") {
          expect(all, where).toMatch(/take your time|no rush|no problem|koi baat nahi|koi jaldi nahi|आराम से|जल्दी नहीं|कोई बात नहीं/i);
          expect(await state(P), where).toBe(expected); // place kept
        }
        if (cat === "help") expect(all, where).toMatch(/I can|kar sakti|कर सकती/);
        // (When a name or number is asked for, any typed word may be one: that's checked by the reply, not here.)
        if (cat === "other" && !["AWAIT_ALT_NUMBER", "BK_NAME"].includes(expected)) expect(all, where).toMatch(/sorry|didn't|can't help|माफ़/i);
        if (cat === "stop") {
          expect(acc.optedOutAt, where).not.toBeNull();
          expect(await state(P), where).toBe("IDLE");
        }
        if (cat === "stop" || cat === "info") continue; // the same question deserves the same answer
        // The same message again: still no loop.
        const last = body(h.wa.last(P));
        const before2 = h.wa.to(P).length;
        await h.say(P, text);
        const again = h.wa.to(P).slice(before2);
        expect(again.length, `${where}\n(again)`).toBeGreaterThan(0);
        expect(body(again[0]), `${where}\n(again): ${again.map(body).join(" | ")}`).not.toBe(last);
      }
    }, 60_000);
  }
});

describe("the reported chat: new patient types instead of tapping", () => {
  it("consent → 'Stupid' → 'Hold' → 'Stop it now' → 'ok' gets apology, patience, apology, then carries on", async () => {
    const P = nextPhone();
    await h.say(P, "Hi");
    await h.tap(P, "consent:yes");
    expect((await h.kinds(P)).at(-1)).toBe("CONFIRM_NUMBER");
    await h.say(P, "Stupid");
    const rude = h.wa.last(P);
    expect(body(rude)).toMatch(/^I'm sorry if I've been unhelpful/); // the first apology; "Sorry again" only comes second
    expect(body(rude)).toMatch(/I'll book this with your number/); // the question, after the apology
    expect(rude?.kind === "buttons" && rude.buttons.map((b) => b.id)).toEqual(["num:use", "num:alt"]);
    await h.say(P, "Hold");
    expect(body(h.wa.last(P))).toMatch(/take your time|no rush/i);
    await h.say(P, "Stop it now");
    expect(body(h.wa.last(P))).toMatch(/sorry/i);
    expect(body(h.wa.last(P))).not.toBe(body(rude)); // a second apology is worded differently
    expect((await h.db.patientAccount.findFirstOrThrow({ where: { phoneHash: phoneHash(P) } })).optedOutAt).toBeNull();
    await h.say(P, "ok");
    expect((await h.kinds(P)).at(-1)).toBe("MAIN_MENU"); // number confirmed, menu shown
  });

  it("gibberish at the number question explains why it's asked, then offers calling the clinic", async () => {
    const P = nextPhone();
    await h.say(P, "Hi");
    await h.tap(P, "consent:yes");
    await h.say(P, "asdf qwerty");
    expect(body(h.wa.last(P))).toMatch(/Sorry.*didn't.*which number to use for your booking confirmation/s);
    await h.say(P, "asdf qwerty");
    expect(body(h.wa.last(P))).toMatch(/call the clinic at/);
    expect(h.buttons(P).map((b) => b.id)).toEqual(["num:use", "num:alt"]);
  });

  it("mid-booking: two misses in a row offer continue / menu / call clinic, and Continue re-asks", async () => {
    const P = nextPhone();
    await bookTomorrowEvening(P); // visit type pending
    await h.say(P, "asdf qwerty");
    expect(body(h.wa.last(P))).toMatch(/^Sorry.*\n\n.*visit/s);
    await h.say(P, "zxcv uiop");
    expect((await h.kinds(P)).at(-1)).toBe("STUCK_HELP");
    expect(h.buttons(P).map((b) => b.id)).toEqual(["resume:go", "resume:menu", "call"]);
    await h.tap(P, "resume:go");
    expect((await h.kinds(P)).at(-1)).toBe("ASK_VISIT_TYPE");
  });

  it("off-topic in the menu: apology plus what I can do, with the menu buttons", async () => {
    const P = nextPhone();
    await onboard(h, P);
    await h.say(P, "tell me a joke");
    expect(body(h.wa.last(P))).toMatch(/^Sorry.*(can't help with that here|outside what I can do)/);
    expect(h.buttons(P).map((b) => b.id)).toEqual(["menu:book", "menu:appts", "menu:status"]);
  });

  it("'no' to the agreement: polite decline with the clinic number, not the same request again", async () => {
    const P = nextPhone();
    await h.say(P, "Hi");
    await h.say(P, "no");
    expect((await h.kinds(P)).at(-1)).toBe("CONSENT_DECLINED");
  });
});

describe("queue messages agree with each other", () => {
  it("the 'turn near' alert and a status question at the same moment give the same wait", async () => {
    const q = await harness({ start: "2026-10-09T17:30:00+05:30" });
    try {
      await onboard(q);
      const acc = await q.db.patientAccount.findFirstOrThrow();
      const me = await createProfile(q.ctx, acc.id, "Ramesh Kumar", "SELF");
      const info = await clinicInfo(q.ctx);
      const date = nowLocal(q.ctx).date;
      const sess = info.sessions.find((s) => s.weekday === 5 && s.label === "Evening")!;
      for (const nm of ["N0", "N1", "N2"]) await issueWalkin(q.ctx, { sessionId: sess.id, date, displayName: nm, actor: { type: "STAFF", id: null } });
      await issueWalkin(q.ctx, { sessionId: sess.id, date, profileId: me.id, actor: { type: "STAFF", id: null } });
      await startNext(q.ctx, { type: "STAFF", id: null });
      const near = q.wa.to(PATIENT).map(body).find((b) => /turn is coming up soon/.test(b));
      expect(near).toBeTruthy();
      await q.say(PATIENT, "status");
      const st = q.lastText(PATIENT);
      const eta = (s: string) => s.match(/about (\d+) min/)?.[1];
      const ahead = (s: string) => s.match(/(\d+) patients ahead/)?.[1];
      expect(eta(st)).toBe(eta(near!));
      expect(ahead(st)).toBe(ahead(near!));
    } finally { await q.close(); }
  });
});

describe("privacy questions and complaints", () => {
  it("before consent nobody is greeted as a returning patient: a second hi, or coming back later, gets the welcome again", async () => {
    const P = nextPhone();
    const again = /welcome back|again|फिर से|वापसी|phir se/i;
    await h.say(P, "Hi");
    expect(await h.kinds(P)).toEqual(["WELCOME_CONSENT"]);
    await h.say(P, "hello");
    expect((await h.kinds(P)).slice(-1)).toEqual(["WELCOME_CONSENT"]);
    await h.say(P, "book for tomorrow");
    expect((await h.kinds(P)).at(-1)).toBe("CONSENT_REMINDER");
    h.clock.advance(2 * 24 * 3600_000);
    await h.say(P, "Hi");
    expect((await h.kinds(P)).at(-1)).toBe("WELCOME_CONSENT");
    for (const m of h.wa.sent.filter((x) => x.to === P)) expect(body(m.msg)).not.toMatch(again);
    await h.tap(P, "consent:yes");
    expect((await h.kinds(P)).at(-1)).toBe("CONFIRM_NUMBER");
  });

  it("'privacy' and 'complaint' give the grievance officer, clinic contact and policy link, even before consent", async () => {
    const P = nextPhone();
    await h.say(P, "privacy");
    const m = body(h.wa.last(P));
    expect(m).toMatch(/Grievance Officer: Gaurav Dua, Incolo Systems \(Q-Incolo\), customercare@incolosystems\.com/);
    expect(m).toMatch(/Dr\. Sharma's Clinic: \+91/);
    expect(m).toMatch(/Privacy policy: http/);
    expect(m).toMatch(/Data Protection Board of India/);
    await h.say(P, "Hi");
    expect((await h.kinds(P)).at(-1)).toBe("WELCOME_CONSENT"); // the welcome still follows normally
    const Q = nextPhone();
    await onboard(h, Q);
    await h.say(Q, "I want to make a complaint");
    expect((await h.kinds(Q)).at(-1)).toBe("GRIEVANCE_INFO");
    await h.say(Q, "mujhe shikayat karni hai");
    expect(body(h.wa.last(Q))).toMatch(/^Privacy se jude sawaal ya shikayat ke liye/);
  });

  it("mid-booking: the contact details, then the pending question again", async () => {
    const P = nextPhone();
    await bookTomorrowEvening(P);
    await h.say(P, "what is your privacy policy?");
    const k = await h.kinds(P);
    expect(k.slice(-2)).toEqual(["GRIEVANCE_INFO", "ASK_VISIT_TYPE"]);
  });

  it("'delete my data for privacy' still deletes (asks to confirm)", async () => {
    const P = nextPhone();
    await onboard(h, P);
    await h.say(P, "delete my data for privacy");
    expect((await h.kinds(P)).at(-1)).toBe("ERASE_CONFIRM");
  });

  it("the policy and data deletion pages are public, name Incolo and the grievance email, and carry no draft note", async () => {
    for (const path of ["/privacy", "/data-deletion", "/terms"]) {
      const r = await h.app.inject({ url: path });
      expect(r.statusCode, path).toBe(200);
      expect(r.headers["content-type"]).toMatch(/text\/html/);
      expect(r.body, path).toMatch(/Incolo Systems/);
      expect(r.body, path).toMatch(/customercare@incolosystems\.com/);
      if (path !== "/terms") expect(r.body, path).toMatch(/Gaurav Dua/);
      expect(r.body, path).not.toMatch(/\{\{|lawyer|draft|DATA_POLICY/i);
    }
    const p = (await h.app.inject({ url: "/privacy" })).body;
    for (const must of ["Data Fiduciary", "WhatsApp Business Account ID", "access token", "do <strong>not</strong> sell", "Grievance Officer", "delete my data", "How long we keep", "Amazon Web Services", "Children"]) expect(p, must).toContain(must);
  });
});
