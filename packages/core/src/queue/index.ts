// Token queue engine (docs/QUEUE_ENGINE.md §4). Pure functions; times are clinic-local minutes.

export type QueueState = "WAITING" | "NEXT" | "IN_CONSULT" | "COMPLETED" | "NO_SHOW" | "CANCELLED";

export interface QEntry {
  id: string;
  token: string;
  tokenNum: number;
  source: "A" | "W";
  state: QueueState;
  arrivedMin: number;
  slotStartMin?: number | null;
  expectedMin?: number | null;
  lateArrival?: boolean;
  manualRank?: number | null;
}

export interface QueueSettings {
  maxConsecutiveWalkins: number; // fairness guard (default 2)
  dueLeadMinutes: number; // appointment counts as due this many minutes before its slot (default 5)
}

export const DEFAULT_QUEUE_SETTINGS: QueueSettings = { maxConsecutiveWalkins: 2, dueLeadMinutes: 5 };

/** Effective ordering time (§4.3 rule 4). */
export function effTime(e: QEntry): number {
  if (e.source === "A" && !e.lateArrival && e.slotStartMin != null) return e.slotStartMin;
  if (e.source === "W" && e.expectedMin != null) return e.expectedMin;
  return e.arrivedMin;
}

function tiebreak(a: QEntry, b: QEntry): number {
  if (a.source !== b.source) return a.source === "A" ? -1 : 1;
  return a.tokenNum - b.tokenNum;
}

/**
 * Who becomes NEXT. `recentSources` = sources of the most recently promoted entries, newest last.
 */
export function pickNext(waiting: QEntry[], nowMin: number, recentSources: ("A" | "W")[], s: QueueSettings = DEFAULT_QUEUE_SETTINGS): QEntry | null {
  const pool = waiting.filter((e) => e.state === "WAITING");
  if (!pool.length) return null;
  // 1. manual overrides
  const ranked = pool.filter((e) => e.manualRank != null).sort((a, b) => a.manualRank! - b.manualRank!);
  if (ranked.length) return ranked[0]!;
  // 2. due appointments
  const due = pool
    .filter((e) => e.source === "A" && !e.lateArrival && e.slotStartMin != null && e.slotStartMin <= nowMin + s.dueLeadMinutes)
    .sort((a, b) => a.slotStartMin! - b.slotStartMin! || tiebreak(a, b));
  if (due.length) return due[0]!;
  // 3. fairness guard
  const lastN = recentSources.slice(-s.maxConsecutiveWalkins);
  const anyA = pool.filter((e) => e.source === "A").sort((a, b) => effTime(a) - effTime(b) || tiebreak(a, b));
  if (lastN.length === s.maxConsecutiveWalkins && lastN.every((x) => x === "W") && anyA.length) return anyA[0]!;
  // 4. everyone else by effective time
  return [...pool].sort((a, b) => effTime(a) - effTime(b) || tiebreak(a, b))[0]!;
}

/** Waiting list in the order repeated pickNext would call them (board, TV and STATUS order). */
export function positions(waiting: QEntry[], nowMin: number, recentSources: ("A" | "W")[], s: QueueSettings = DEFAULT_QUEUE_SETTINGS): QEntry[] {
  const left = waiting.filter((e) => e.state === "WAITING");
  const recent = [...recentSources];
  const out: QEntry[] = [];
  let clock = nowMin;
  while (left.length) {
    const n = pickNext(left, clock, recent, s)!;
    out.push(n);
    recent.push(n.source);
    left.splice(left.indexOf(n), 1);
    clock += 1; // simulated progression keeps "due" evaluation monotonic
  }
  return out;
}

export interface EtaInput {
  avgConsultMin: number;
  inConsultElapsedMin: number | null; // null when nobody is in consultation
  hasNext: boolean;
  delayMin: number;
  pauseRemainingMin: number;
}

/** Minutes until a WAITING entry at 0-based position k is called in (§4.4). */
export function etaMinutes(k: number, e: EtaInput): number {
  const remainingCurrent = e.inConsultElapsedMin == null ? 0 : Math.max(0, e.avgConsultMin - e.inConsultElapsedMin);
  return remainingCurrent + (e.hasNext ? e.avgConsultMin : 0) + k * e.avgConsultMin + e.delayMin + e.pauseRemainingMin;
}

/** "about 25 min" granularity: round to 5, never below 5. */
export function roundEta(min: number): number {
  return Math.max(5, Math.round(min / 5) * 5);
}

/** Mean of the last 10 consult durations; slot length until 3 consults exist. */
export function avgConsult(durations: number[], slotMinutes: number): number {
  const last = durations.slice(-10);
  if (last.length < 3) return slotMinutes;
  return Math.round(last.reduce((a, b) => a + b, 0) / last.length);
}

/** Patients ahead of a WAITING entry: NEXT (if any) + those before it in positions(). */
export function aheadCount(entryId: string, ordered: QEntry[], hasNext: boolean): number {
  const k = ordered.findIndex((e) => e.id === entryId);
  return (hasNext ? 1 : 0) + (k < 0 ? ordered.length : k);
}

export interface AdvancePlan {
  complete?: string; // IN_CONSULT → COMPLETED
  start?: string; // NEXT → IN_CONSULT
  promote?: string; // WAITING → NEXT
}

/** "Consultation completed" composite (§4.2). */
export function planAdvance(entries: QEntry[], nowMin: number, recentSources: ("A" | "W")[], s: QueueSettings = DEFAULT_QUEUE_SETTINGS): AdvancePlan {
  const inConsult = entries.find((e) => e.state === "IN_CONSULT");
  const next = entries.find((e) => e.state === "NEXT");
  const plan: AdvancePlan = {};
  if (inConsult) plan.complete = inConsult.id;
  if (next) plan.start = next.id;
  const waiting = entries.filter((e) => e.state === "WAITING");
  const p = pickNext(waiting, nowMin, next ? [...recentSources] : recentSources, s);
  if (p) plan.promote = p.id;
  return plan;
}

const ALLOWED: Record<QueueState, QueueState[]> = {
  WAITING: ["NEXT", "CANCELLED", "NO_SHOW"],
  NEXT: ["IN_CONSULT", "NO_SHOW", "CANCELLED", "WAITING"],
  IN_CONSULT: ["COMPLETED", "NEXT"],
  COMPLETED: [],
  NO_SHOW: ["WAITING"],
  CANCELLED: [],
};

export function canTransition(from: QueueState, to: QueueState): boolean {
  return ALLOWED[from].includes(to);
}
