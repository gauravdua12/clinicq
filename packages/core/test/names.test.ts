import { describe, expect, it } from "vitest";
import { postValidate } from "../src/extract/cascade";
import { emptyExtraction } from "../src/extract/schema";

describe("name sanitising keeps Indic scripts intact", () => {
  it("keeps Devanagari vowel signs", () => {
    const e = postValidate({ ...emptyExtraction("hi"), newPersonName: "दर्शना कुमारी", forWhom: "new_person" }, { today: "2026-10-10", nowTime: "12:00", sessions: [], profiles: [], state: "IDLE" });
    expect(e.newPersonName).toBe("दर्शना कुमारी");
  });
  it("strips digits and symbols", () => {
    const e = postValidate({ ...emptyExtraction(), selfName: "anil <b>verma</b> 123" }, { today: "2026-10-10", nowTime: "12:00", sessions: [], profiles: [], state: "IDLE" });
    expect(e.selfName).not.toMatch(/[<>0-9]/);
  });
});

import { extract } from "../src/extract/cascade";
describe("info questions that name a day", () => {
  const ctx = { today: "2026-10-09", nowTime: "12:00", sessions: [], profiles: [], state: "IDLE" };
  it("'open on Sunday?' stays a timings question; 'any slot Monday?' becomes a booking", () => {
    const base = { ...emptyExtraction(), date: "2026-10-11" };
    expect(postValidate({ ...base, intent: "CLINIC_INFO", clinicInfoTopic: "timings" }, ctx as never).intent).toBe("CLINIC_INFO");
    expect(postValidate({ ...base, intent: "STATUS" }, ctx as never).intent).toBe("BOOK");
    expect(postValidate({ ...base, intent: "CLINIC_INFO", clinicInfoTopic: "timings", time: "19:00" }, ctx as never).intent).toBe("BOOK"); // "open Monday at 7?"
  });
});
describe("time guards", () => {
  const ctx = { today: "2026-10-09", nowTime: "12:00", sessions: [{ weekday: 6, label: "Morning", start: "10:00", end: "13:00" }], profiles: [], state: "IDLE" };
  const fake = (time: string, tq: string) => ({ spec: "fake", call: async () => ({ json: { intent: "BOOK", date: "2026-10-10", time, timeQualifier: tq, partOfDay: "morning", forWhom: "self", profileRef: null, newPersonName: null, relation: null, selfName: null, phone: null, visitType: null, clinicInfoTopic: null, language: "en", hasNonBookingContent: false, possibleEmergency: false, confidence: 0.95 } }) });
  it("drops a time the patient never said", async () => {
    const o = await extract("Saturday morning appointment", ctx, { primary: fake("10:00", "exact"), escalation: null, minConfidence: 0.7, timeoutMs: 1000 });
    expect(o.extraction.time).toBeNull();
  });
  it("a duration or amount is not a time ('3 din se', '2 weeks', '₹500', '5 saal')", async () => {
    for (const t of ["3 din se bukhar aur khansi hai, kal subah dikhana hai", "coughing for 2 weeks, need tomorrow morning", "fees ₹500 hai? kal subah aana hai", "मेरे बेटे की उम्र 5 साल है, कल सुबह दिखाना है"]) {
      const o = await extract(t, ctx, { primary: fake("10:00", "exact"), escalation: null, minConfidence: 0.7, timeoutMs: 1000 });
      expect(o.extraction.time, t).toBeNull();
    }
    for (const t of ["kal subah 10 baje", "tomorrow 11", "3 din baad 10:30 baje"]) {
      const o = await extract(t, ctx, { primary: fake("10:00", "exact"), escalation: null, minConfidence: 0.7, timeoutMs: 1000 });
      expect(o.extraction.time, t).not.toBeNull();
    }
  });
  it("treats a range as 'around', never exact", async () => {
    for (const t of ["kal subah 10 se 11 ke beech koi bhi slot", "between 10 and 11 tomorrow", "कल सुबह 10 से 11 के बीच"]) {
      const o = await extract(t, ctx, { primary: fake("10:00", "exact"), escalation: null, minConfidence: 0.7, timeoutMs: 1000 });
      expect(o.extraction.timeQualifier, t).toBe("around");
    }
  });
  it("keeps a genuinely exact time", async () => {
    const o = await extract("book 10:20 tomorrow", ctx, { primary: fake("10:20", "exact"), escalation: null, minConfidence: 0.7, timeoutMs: 1000 });
    expect(o.extraction.timeQualifier).toBe("exact");
  });
});
