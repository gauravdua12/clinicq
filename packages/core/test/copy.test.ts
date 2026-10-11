import { describe, expect, it } from "vitest";
import { BTN, COPY, btn, render, type BtnId, type CopyId } from "../src/copy";

const LANGS = ["en", "hi", "hinglish"] as const;

describe("copy bank", () => {
  it("every message exists in all three languages", () => {
    for (const [id, e] of Object.entries(COPY)) for (const l of LANGS) expect((e as Record<string, unknown>)[l], `${id}.${l}`).toBeTruthy();
  });
  it("every language uses the same variables as English", () => {
    const vars = (s: unknown) => new Set(JSON.stringify(s).match(/\{\{\w+\}\}/g) ?? []);
    for (const [id, e] of Object.entries(COPY)) {
      const en = vars((e as { en: unknown }).en);
      for (const l of ["hi", "hinglish"] as const) expect([...vars((e as Record<string, unknown>)[l])].sort(), `${id}.${l}`).toEqual([...en].sort());
    }
  });
  it("button labels fit WhatsApp's 20-character limit", () => {
    for (const [id, e] of Object.entries(BTN)) {
      for (const l of LANGS) {
        const label = btn(id as BtnId, l, { phone: "+91 98765 43210", time: "10:20 AM" });
        expect([...label].length, `${id}.${l}: ${label}`).toBeLessThanOrEqual(20);
        expect([...(e as Record<string, string>)[l]!.replace("{{phone}}", "+91 98765 43210").replace("{{time}}", "10:20 AM")].length, `${id}.${l} raw`).toBeLessThanOrEqual(20);
      }
    }
  });
  it("renders variables and leaves no placeholders", () => {
    const s = render("BOOKING_CONFIRMED" as CopyId, "en", { name: "Sunita", dayShort: "Sat 10 Oct", time: "6:10 PM", token: "A-4", clinicName: "Dr. Sharma's Clinic", addressShort: "Sector 15", mapsLine: "" });
    expect(s).toContain("Token *A-4*");
    expect(s).not.toMatch(/\{\{/);
  });
  it("bodies stay under WhatsApp's 1024-char interactive limit", () => {
    for (const [id, e] of Object.entries(COPY)) for (const l of LANGS) {
      const v = (e as Record<string, string | string[]>)[l]!;
      for (const s of Array.isArray(v) ? v : [v]) expect(s.length, id).toBeLessThan(900);
    }
  });
});
