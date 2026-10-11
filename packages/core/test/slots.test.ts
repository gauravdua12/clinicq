import { describe, expect, it } from "vitest";
import {
  findNearSlots, freeSlotsOn, generateSlots, nextAdjacentFree, bookability, slotRef, findSlot,
  type AvailabilityInput, type SessionDef,
} from "../src/slots";
import { fmtTime, toMin } from "../src/time";

// Worked examples from docs/QUEUE_ENGINE.md §6 (calendar: Sat 10 Oct 2026, session 17:10–20:00, 20-min slots).
const EVE: SessionDef = { id: "eve-sat", weekday: 6, label: "Evening", startTime: "17:10", endTime: "20:00", slotMinutes: 20, walkinQuota: 10 };
const MORN_MON: SessionDef = { id: "morn-mon", weekday: 1, label: "Morning", startTime: "10:00", endTime: "13:00", slotMinutes: 20, walkinQuota: 10 };
const D = "2026-10-10";

function inp(taken: string[] = [], now = { date: "2026-10-09", min: toMin("12:00") }): AvailabilityInput {
  return {
    nowDate: now.date, nowMin: now.min, sessions: [EVE, MORN_MON], closures: [],
    taken: new Set(taken.map((t) => slotRef(D, toMin(t)))), blocked: new Set(),
    rules: { windowDays: 7, cutoffMinutes: 60, nearWindowMinutes: 60 },
  };
}
const times = (xs: { startMin: number }[]) => xs.map((s) => fmtTime(s.startMin));

describe("generateSlots", () => {
  it("drops the trailing partial slot", () => {
    expect(times(generateSlots(D, EVE))).toEqual(["5:10 PM", "5:30 PM", "5:50 PM", "6:10 PM", "6:30 PM", "6:50 PM", "7:10 PM", "7:30 PM"]);
  });
});

describe("findNearSlots (smart suggest)", () => {
  it("E1: two nearest to 18:00, chronological", () => {
    const r = findNearSlots({ date: D, time: toMin("18:00") }, inp(["17:30", "18:30"]));
    expect(times(r.near)).toEqual(["5:50 PM", "6:10 PM"]);
  });
  it("E2: nothing near → empty, but hasAny", () => {
    const r = findNearSlots({ date: D, time: toMin("18:00") }, inp(["17:10", "17:30", "17:50", "18:10", "18:30", "18:50", "19:10"]));
    expect(r.near).toEqual([]);
    expect(r.hasAny).toBe(true);
  });
  it("E3: date only → earliest two", () => {
    const r = findNearSlots({ date: "2026-10-12" }, { ...inp(), nowDate: "2026-10-11", nowMin: toMin("15:00") });
    expect(times(r.near)).toEqual(["10:00 AM", "10:20 AM"]);
  });
  it("E4: cut-off removes slots within 60 min", () => {
    const r = findNearSlots({ date: D, time: toMin("18:00") }, inp([], { date: D, min: toMin("17:30") }));
    expect(times(r.near)).toEqual(["6:30 PM", "6:50 PM"]);
  });
  it("E5: race alternatives exclude the lost slot", () => {
    const r = findNearSlots({ date: D, time: toMin("18:10"), exclude: new Set([slotRef(D, toMin("18:10"))]) }, inp(["17:30"]));
    expect(times(r.near)).toEqual(["5:50 PM", "6:30 PM"]);
  });
  it("after-qualifier only offers later slots", () => {
    const r = findNearSlots({ date: D, time: toMin("19:00"), timeQualifier: "after" }, inp());
    expect(times(r.near)).toEqual(["7:10 PM", "7:30 PM"]);
  });
  it("part of day picks the matching session", () => {
    const r = findNearSlots({ date: D, partOfDay: "evening" }, inp());
    expect(times(r.near)).toEqual(["5:10 PM", "5:30 PM"]);
  });
  it("never returns more than 2, never outside a session", () => {
    for (let h = 8; h <= 22; h++) {
      const r = findNearSlots({ date: D, time: h * 60 }, inp());
      expect(r.near.length).toBeLessThanOrEqual(2);
      for (const s of r.near) expect(s.startMin).toBeGreaterThanOrEqual(toMin("17:10"));
    }
  });
});

describe("bookability", () => {
  it("closed day, past, beyond window", () => {
    const sun = { date: "2026-10-11", sessionId: "eve-sat", sessionLabel: "Evening", startMin: 1090, endMin: 1110, index: 4 };
    expect(bookability(sun, inp())).toBe("closed");
    const past = findSlot(D, toMin("17:10"), inp())!;
    expect(bookability(past, inp([], { date: D, min: toMin("18:00") }))).toBe("past");
    expect(bookability(past, inp([], { date: "2026-09-30", min: 0 }))).toBe("beyond_window");
  });
});

describe("E6: family same slot → next adjacent", () => {
  it("offers 18:50 when 18:30 is taken", () => {
    const i = inp(["18:30"]);
    const slot = findSlot(D, toMin("18:30"), i)!;
    expect(fmtTime(nextAdjacentFree(slot, i)!.startMin)).toBe("6:50 PM");
  });
});

describe("E14: slot index", () => {
  it("18:10 is index 3 → A-4", () => {
    expect(findSlot(D, toMin("18:10"), inp())!.index + 1).toBe(4);
    expect(freeSlotsOn(D, inp()).length).toBe(8);
  });
});
