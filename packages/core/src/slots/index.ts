import { addDays, daysBetween, PART_OF_DAY_RANGE, toMin, weekdayOf } from "../time";

// Slot engine (docs/QUEUE_ENGINE.md §2). Pure: works in clinic-local dates and minutes.

export interface SessionDef {
  id: string;
  weekday: number; // 0=Sun
  label: string;
  startTime: string; // "17:10"
  endTime: string; // "20:00"
  slotMinutes: number;
  walkinQuota: number;
  active?: boolean;
}

export interface ClosureDef {
  date: string;
  sessionId: string | null; // null = whole day
}

export interface Slot {
  date: string;
  sessionId: string;
  sessionLabel: string;
  startMin: number;
  endMin: number;
  index: number; // 0-based position within the session instance
}

export interface BookingRules {
  windowDays: number;
  cutoffMinutes: number;
  nearWindowMinutes: number;
}

export interface AvailabilityInput {
  nowDate: string;
  nowMin: number;
  sessions: SessionDef[];
  closures: ClosureDef[];
  taken: Set<string>; // slotRef() of active appointments (HELD unexpired, BOOKED, ARRIVED)
  blocked: Set<string>; // slotRef() blocked by staff
  rules: BookingRules;
}

export const slotRef = (date: string, startMin: number) => `${date}|${startMin}`;

export function sessionsOn(date: string, sessions: SessionDef[], closures: ClosureDef[]): SessionDef[] {
  const wd = weekdayOf(date);
  const dayClosed = closures.some((c) => c.date === date && c.sessionId === null);
  if (dayClosed) return [];
  return sessions
    .filter((s) => s.weekday === wd && s.active !== false && !closures.some((c) => c.date === date && c.sessionId === s.id))
    .sort((a, b) => toMin(a.startTime) - toMin(b.startTime));
}

export function generateSlots(date: string, s: SessionDef): Slot[] {
  const out: Slot[] = [];
  const start = toMin(s.startTime);
  const end = toMin(s.endTime);
  for (let m = start, i = 0; m + s.slotMinutes <= end; m += s.slotMinutes, i++) {
    out.push({ date, sessionId: s.id, sessionLabel: s.label, startMin: m, endMin: m + s.slotMinutes, index: i });
  }
  return out;
}

export type BookableReason = "ok" | "past" | "cutoff" | "beyond_window" | "closed" | "taken" | "blocked";

export function bookability(slot: Slot, inp: AvailabilityInput): BookableReason {
  const d = daysBetween(inp.nowDate, slot.date);
  if (d < 0 || (d === 0 && slot.startMin <= inp.nowMin)) return "past";
  if (d === 0 && slot.startMin < inp.nowMin + inp.rules.cutoffMinutes) return "cutoff";
  if (d > inp.rules.windowDays) return "beyond_window";
  if (!sessionsOn(slot.date, inp.sessions, inp.closures).some((s) => s.id === slot.sessionId)) return "closed";
  const ref = slotRef(slot.date, slot.startMin);
  if (inp.blocked.has(ref)) return "blocked";
  if (inp.taken.has(ref)) return "taken";
  return "ok";
}

export function allSlotsOn(date: string, inp: Pick<AvailabilityInput, "sessions" | "closures">): Slot[] {
  return sessionsOn(date, inp.sessions, inp.closures).flatMap((s) => generateSlots(date, s));
}

export function freeSlotsOn(date: string, inp: AvailabilityInput): Slot[] {
  return allSlotsOn(date, inp).filter((s) => bookability(s, inp) === "ok");
}

export function findSlot(date: string, startMin: number, inp: Pick<AvailabilityInput, "sessions" | "closures">): Slot | null {
  return allSlotsOn(date, inp).find((s) => s.startMin === startMin) ?? null;
}

export interface NearRequest {
  date: string;
  time?: number | null; // minutes
  timeQualifier?: "exact" | "around" | "after" | "before" | null;
  partOfDay?: "morning" | "afternoon" | "evening" | "night" | null;
  exclude?: Set<string>; // slotRefs to skip (e.g. the one just lost in a race)
}

export interface NearResult {
  near: Slot[]; // 0..2, chronological
  hasAny: boolean; // any free slot on request.date
}

/** Smart suggest — form E (QUEUE_ENGINE §2.3). */
export function findNearSlots(req: NearRequest, inp: AvailabilityInput, take = 2): NearResult {
  let candidates = freeSlotsOn(req.date, inp).filter((s) => !req.exclude?.has(slotRef(s.date, s.startMin)));
  const hasAny = candidates.length > 0;
  let picked: Slot[];
  if (req.time != null) {
    const t = req.time;
    if (req.timeQualifier === "after") candidates = candidates.filter((s) => s.startMin >= t);
    if (req.timeQualifier === "before") candidates = candidates.filter((s) => s.startMin < t);
    picked = candidates
      .filter((s) => Math.abs(s.startMin - t) <= inp.rules.nearWindowMinutes)
      .sort((a, b) => Math.abs(a.startMin - t) - Math.abs(b.startMin - t) || a.startMin - b.startMin)
      .slice(0, take);
  } else if (req.partOfDay) {
    const [lo, hi] = PART_OF_DAY_RANGE[req.partOfDay];
    const sessionIds = new Set(sessionsOn(req.date, inp.sessions, inp.closures).filter((s) => toMin(s.startTime) < hi && toMin(s.endTime) > lo).map((s) => s.id));
    picked = candidates.filter((s) => sessionIds.has(s.sessionId)).slice(0, take);
  } else {
    picked = candidates.slice(0, take);
  }
  return { near: picked.sort((a, b) => a.startMin - b.startMin), hasAny };
}

/** First date (from `from`, inclusive) within the window that has any free slot. */
export function firstDateWithFree(from: string, inp: AvailabilityInput): string | null {
  for (let i = 0; i <= inp.rules.windowDays; i++) {
    const d = addDays(from, i);
    if (daysBetween(inp.nowDate, d) > inp.rules.windowDays) return null;
    if (freeSlotsOn(d, inp).length) return d;
  }
  return null;
}

/** Earliest free slots from `from` onward (used for "next available" offers). */
export function nextFreeSlots(from: string, afterMin: number, inp: AvailabilityInput, take = 2): Slot[] {
  const out: Slot[] = [];
  for (let i = 0; i <= inp.rules.windowDays && out.length < take; i++) {
    const d = addDays(from, i);
    if (daysBetween(inp.nowDate, d) > inp.rules.windowDays) break;
    for (const s of freeSlotsOn(d, inp)) {
      if (i === 0 && s.startMin < afterMin) continue;
      out.push(s);
      if (out.length >= take) break;
    }
  }
  return out;
}

/** Next free slot after `slot` in the same session instance, else the nearest later free one that day. */
export function nextAdjacentFree(slot: Slot, inp: AvailabilityInput): Slot | null {
  return freeSlotsOn(slot.date, inp).find((s) => s.startMin > slot.startMin) ?? null;
}

/** Dates for the Flow date chips: next N days with open/closed flags. */
export function flowDates(inp: AvailabilityInput): { date: string; open: boolean; free: number }[] {
  const out = [];
  for (let i = 0; i <= inp.rules.windowDays; i++) {
    const d = addDays(inp.nowDate, i);
    const open = sessionsOn(d, inp.sessions, inp.closures).length > 0;
    out.push({ date: d, open, free: open ? freeSlotsOn(d, inp).length : 0 });
  }
  return out;
}
