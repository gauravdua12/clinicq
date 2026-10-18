import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { phoneHash } from "@clinicq/db";
import type { SpeechToText } from "@clinicq/ai/stt";
import { harness, onboard, type H } from "../harness";

// Voice notes: booking and cancelling by voice (English, Hindi, Hinglish), and what the patient hears when the voice
// note can't be understood or speech-to-text is down: a clear reply at once, then the pending question or the options.

let h: H;
let n = 0;
const nextPhone = () => `9197${String(++n).padStart(8, "0")}`;
beforeEach(async () => { h = await harness({ start: "2026-10-09T12:00:00+05:30" }); });
afterEach(async () => h?.close());

const mine = (P: string, status: string) => h.db.appointment.count({ where: { status: status as never, profile: { account: { phoneHash: phoneHash(P) } } } });
async function booked(P: string, when = "Monday morning"): Promise<void> {
  await onboard(h, P);
  await h.say(P, `book ${when} for me`);
  await h.tap(P, "who:me"); await h.tap(P, h.buttons(P)[0]!.id); await h.tap(P, "vt:NEW"); await h.tap(P, "bk:yes");
  expect(await mine(P, "BOOKED")).toBe(1);
}
function failing(name: string, err: Record<string, unknown>): SpeechToText & { calls: number } {
  return { name, calls: 0, async transcribe() { this.calls++; throw Object.assign(new Error(String(err.message ?? "x")), err); } };
}

describe("booking and cancelling by voice", () => {
  it("English and Hindi voice notes book a time", async () => {
    for (const spoken of ["I want an appointment on Monday morning", "मुझे सोमवार सुबह अपॉइंटमेंट चाहिए", "Mujhe Monday evening ka appointment chahiye"]) {
      const P = nextPhone(); await onboard(h, P);
      await h.voice(P, spoken);
      const k = await h.kinds(P);
      expect(k, spoken).not.toContain("VOICE_UNCLEAR");
      expect(k, spoken).not.toContain("VOICE_UNAVAILABLE");
      expect(["ASK_WHO", "OFFER_NEAR_SLOTS", "LIST_PICKER", "BOOK_LINK"], `${spoken}: ${k.join("+")}`).toContain(k.at(-1));
    }
  });
  it("English and Hindi voice notes cancel the appointment (with confirmation)", async () => {
    for (const spoken of ["Please cancel my appointment", "मेरी अपॉइंटमेंट कैंसल कर दो", "Meri appointment cancel kar do"]) {
      const P = nextPhone(); await booked(P);
      await h.voice(P, spoken);
      expect((await h.kinds(P)).at(-1), spoken).toBe("CX_CONFIRM");
      await h.tap(P, h.buttons(P)[0]!.id);
      expect(await mine(P, "BOOKED"), spoken).toBe(0);
    }
  });
});

describe("when the voice note can't be understood", () => {
  it("nothing heard: says so and asks the pending question again", async () => {
    const P = nextPhone(); await onboard(h, P); await h.say(P, "book Monday morning for me"); await h.tap(P, "who:me");
    await h.voice(P, "hmm");
    const k = await h.kinds(P);
    expect(k.at(-2)).toBe("VOICE_UNCLEAR");
    expect(k.at(-1)).not.toBe("VOICE_UNCLEAR");
    expect(h.buttons(P).length).toBeGreaterThan(0); // the times are offered again
  });

  it("speech-to-text down: an immediate 'please type', the options, and the broken service is skipped next time", async () => {
    const quota = failing("voxtral", { name: "ThrottlingException", message: "Too many tokens per day, please wait before trying again." });
    const sub = failing("transcribe", { name: "SubscriptionRequiredException", message: "The AWS Access Key Id needs a subscription for the service" });
    h.ctx.stt = async () => [quota, sub];
    const P = nextPhone(); await onboard(h, P);
    await h.voice(P, "book Monday");
    const k = await h.kinds(P);
    expect(k.slice(-2)).toEqual(["VOICE_UNAVAILABLE", "OTHER_HELP"]);
    expect(h.lastText(P)).not.toBe("");
    expect([quota.calls, sub.calls]).toEqual([1, 1]);
    await h.voice(P, "book Monday");
    expect([quota.calls, sub.calls]).toEqual([1, 1]); // not called again for 10 minutes: no waiting
    expect((await h.kinds(P)).at(-2)).toBe("VOICE_UNAVAILABLE");
    h.clock.advanceMinutes(11);
    await h.voice(P, "book Monday");
    expect([quota.calls, sub.calls]).toEqual([2, 2]); // tried again later
  });

  it("first service down, second works: the voice note is understood", async () => {
    const down = failing("voxtral-x", { name: "ValidationException", message: "This model doesn't support the audio format" });
    const works: SpeechToText = { name: "ok-x", async transcribe(a) { return { text: a.toString("utf8") }; } };
    h.ctx.stt = async () => [down, works];
    const P = nextPhone(); await booked(P);
    await h.voice(P, "please cancel my appointment");
    expect((await h.kinds(P)).at(-1)).toBe("CX_CONFIRM");
  });

  it("a passing hiccup (per-minute throttle) is retried on the next voice note", async () => {
    const busy = failing("busy-x", { name: "ThrottlingException", message: "Too many requests, please wait", $metadata: { httpStatusCode: 429 } });
    h.ctx.stt = async () => [busy];
    const P = nextPhone(); await onboard(h, P);
    await h.voice(P, "book Monday"); await h.voice(P, "book Monday");
    expect(busy.calls).toBe(2);
  });

  it("a voice note mid-cancellation that can't be heard shows the cancellation question again", async () => {
    const P = nextPhone(); await booked(P);
    await h.say(P, "cancel my appointment");
    await h.voice(P, "");
    const k = await h.kinds(P);
    expect(k.slice(-2)).toEqual(["VOICE_UNCLEAR", "CX_CONFIRM"]);
    expect(await mine(P, "BOOKED")).toBe(1);
  });
});
