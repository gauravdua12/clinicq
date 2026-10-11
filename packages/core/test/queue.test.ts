import { describe, expect, it } from "vitest";
import { aheadCount, avgConsult, canTransition, etaMinutes, pickNext, planAdvance, positions, roundEta, type QEntry } from "../src/queue";
import { toMin } from "../src/time";

const A = (n: number, slot: string, arrived: string, extra: Partial<QEntry> = {}): QEntry => ({ id: `A${n}`, token: `A-${n}`, tokenNum: n, source: "A", state: "WAITING", arrivedMin: toMin(arrived), slotStartMin: toMin(slot), ...extra });
const W = (n: number, arrived: string, extra: Partial<QEntry> = {}): QEntry => ({ id: `W${n}`, token: `W-${n}`, tokenNum: n, source: "W", state: "WAITING", arrivedMin: toMin(arrived), ...extra });

describe("pickNext (QUEUE_ENGINE §6)", () => {
  it("E7: due appointment first, then walk-ins by arrival", () => {
    const w = [A(4, "18:10", "17:55"), W(1, "17:20"), W(2, "17:40")];
    expect(positions(w, toMin("18:05"), []).map((e) => e.token)).toEqual(["A-4", "W-1", "W-2"]);
  });
  it("E8: fairness guard after two walk-ins", () => {
    const w = [W(3, "17:45"), A(6, "18:50", "17:50")];
    expect(pickNext(w, toMin("18:05"), ["W", "W"])!.token).toBe("A-6");
    expect(pickNext(w, toMin("18:05"), ["A", "W"])!.token).toBe("W-3");
  });
  it("E9: late arrival joins by arrival time", () => {
    const w = [A(2, "17:30", "17:52", { lateArrival: true }), W(3, "17:45")];
    expect(positions(w, toMin("18:00"), ["A"]).map((e) => e.token)).toEqual(["W-3", "A-2"]);
  });
  it("E10: manual move wins", () => {
    const w = [A(4, "18:10", "17:55"), W(5, "18:00", { manualRank: 0 })];
    expect(pickNext(w, toMin("18:10"), [])!.token).toBe("W-5");
  });
  it("E13: staff-assigned expected time orders a walk-in", () => {
    const w = [W(11, "18:00", { expectedMin: toMin("19:50") }), W(12, "18:30")];
    expect(positions(w, toMin("18:40"), []).map((e) => e.token)).toEqual(["W-12", "W-11"]);
  });
});

describe("ETA (E11)", () => {
  it("26 → about 25; with LATE 15 → about 40", () => {
    const avg = avgConsult([12, 8, 10], 20);
    expect(avg).toBe(10);
    const e = { avgConsultMin: avg, inConsultElapsedMin: 4, hasNext: true, delayMin: 0, pauseRemainingMin: 0 };
    expect(etaMinutes(1, e)).toBe(26);
    expect(roundEta(etaMinutes(1, e))).toBe(25);
    expect(roundEta(etaMinutes(1, { ...e, delayMin: 15 }))).toBe(40);
  });
  it("uses slot length until 3 consults", () => expect(avgConsult([7], 20)).toBe(20));
});

describe("planAdvance (E12)", () => {
  it("completes, starts next, promotes top waiting", () => {
    const entries: QEntry[] = [
      A(3, "17:50", "17:40", { state: "IN_CONSULT" }),
      W(1, "17:20", { state: "NEXT" }),
      A(4, "18:10", "17:55"),
      W(2, "17:40"),
    ];
    expect(planAdvance(entries, toMin("18:08"), ["W"])).toEqual({ complete: "A3", start: "W1", promote: "A4" });
    const ordered = positions(entries.filter((e) => e.id === "W2"), toMin("18:08"), []);
    expect(aheadCount("W2", ordered, true)).toBe(1);
  });
});

describe("transitions", () => {
  it("rejects invalid moves", () => {
    expect(canTransition("COMPLETED", "WAITING")).toBe(false);
    expect(canTransition("NO_SHOW", "WAITING")).toBe(true);
    expect(canTransition("WAITING", "IN_CONSULT")).toBe(false);
  });
});
