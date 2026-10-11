import { daysBetween } from "../time";
import { renderUserTurn, type ExtractContext } from "./context";
import { SYSTEM_PROMPT } from "./prompt";
import { rulesExtract } from "./rules";
import { normalizeModelJson, type Extraction } from "./schema";

// Quality-guarded cascade: cheap primary model → superior escalation model → rules (AI_EXTRACTION §4.1).

export interface ModelResult {
  json: unknown;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ModelHandle {
  spec: string; // e.g. "bedrock:openai.gpt-oss-20b-1:0"
  call(system: string, user: string, timeoutMs: number): Promise<ModelResult>;
}

export interface CascadeConfig {
  primary: ModelHandle | null; // null → rules only
  escalation: ModelHandle | null;
  minConfidence: number; // default 0.7
  timeoutMs: number;
}

export interface CallMeta {
  spec: string;
  ok: boolean;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  error?: string; // error class/code only — never message content
  repaired?: boolean;
}

export interface ExtractOutcome {
  extraction: Extraction;
  source: "primary" | "escalation" | "rules";
  escalated: boolean;
  reasons: string[];
  calls: CallMeta[];
}

const DEVANAGARI = /[ऀ-ॿ]/;

function sanitizeName(n: string | null): string | null {
  if (!n) return null;
  const cleaned = n.replace(/[^\p{L}\p{M} .'-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!cleaned) return null;
  return cleaned.split(" ").map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w)).join(" ");
}

/** Clamp model output to what the context allows (no invented profile refs, sane dates). */
export function postValidate(e: Extraction, ctx: ExtractContext): Extraction {
  const out = { ...e };
  if (out.profileRef && !ctx.profiles.some((p) => p.ref === out.profileRef)) {
    out.profileRef = null;
    if (out.forWhom === "existing_profile") out.forWhom = out.relation && out.relation !== "SELF" ? "new_person" : "unknown";
  }
  if (out.forWhom === "self" && !out.profileRef) out.profileRef = ctx.profiles.find((p) => p.relation === "SELF")?.ref ?? null;
  if (out.date && (Number.isNaN(Date.parse(out.date)) || Math.abs(daysBetween(ctx.today, out.date)) > 400)) out.date = null;
  if (out.phone && !/^[6-9]\d{9}$/.test(out.phone)) out.phone = null;
  out.newPersonName = sanitizeName(out.newPersonName);
  out.selfName = sanitizeName(out.selfName);
  if (!out.time) out.timeQualifier = null;
  // A status/info question that names a day or time is a request for a slot ("any slot today evening?").
  // ...but "is the clinic open on Sunday?" (a day, no specific time) is a question about timings, and gets the timings.
  if ((out.intent === "STATUS" || (out.intent === "CLINIC_INFO" && (out.clinicInfoTopic !== "timings" || out.time))) && (out.time || (out.date && out.date !== ctx.today) || (out.date && out.partOfDay)) && ctx.state === "IDLE") out.intent = "BOOK";
  if (out.intent !== "CLINIC_INFO") out.clinicInfoTopic = null;
  return out;
}

async function tryModel(h: ModelHandle, user: string, timeoutMs: number, calls: CallMeta[]): Promise<{ e: Extraction; repaired: boolean } | null> {
  const t0 = Date.now();
  try {
    const r = await withTimeout(h.call(SYSTEM_PROMPT, user, timeoutMs), timeoutMs);
    const n = normalizeModelJson(r.json);
    calls.push({ spec: h.spec, ok: !!n, latencyMs: Date.now() - t0, inputTokens: r.inputTokens, outputTokens: r.outputTokens, error: n ? undefined : "invalid_json", repaired: n?.repaired });
    return n ? { e: n.value, repaired: n.repaired } : null;
  } catch (err) {
    calls.push({ spec: h.spec, ok: false, latencyMs: Date.now() - t0, error: errorCode(err) });
    return null;
  }
}

export function errorCode(err: unknown): string {
  if (err instanceof TimeoutError) return "timeout";
  const e = err as { name?: string; code?: string; status?: number; $metadata?: { httpStatusCode?: number } };
  return String(e?.name ?? e?.code ?? e?.status ?? e?.$metadata?.httpStatusCode ?? "error").slice(0, 60);
}

export class TimeoutError extends Error {}
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError("timeout")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Why a primary result should be double-checked by the superior model. Empty = accept. */
export function escalationReasons(e: Extraction, rules: Extraction, text: string, minConfidence: number): string[] {
  const r: string[] = [];
  if (e.confidence < minConfidence) r.push("low_confidence");
  if (e.intent === "OTHER" && text.trim().split(/\s+/).length >= 3 && !e.hasNonBookingContent) r.push("other_intent");
  if (rules.time && !e.time && ["BOOK", "PROVIDE", "RESCHEDULE", "DENY"].includes(e.intent)) r.push("time_missed");
  if (rules.date && !e.date && ["BOOK", "PROVIDE", "RESCHEDULE"].includes(e.intent)) r.push("date_missed");
  if (rules.date && e.date && rules.date !== e.date) r.push("date_disagreement");
  if (rules.time && e.time && rules.time !== e.time && rules.timeQualifier === "exact") r.push("time_disagreement");
  if (DEVANAGARI.test(text) && e.language !== "hi") r.push("language_mismatch");
  if ((rules.possibleEmergency && !e.possibleEmergency) || (rules.hasNonBookingContent && !e.hasNonBookingContent)) r.push("safety_disagreement");
  // High-impact intents with reliable keywords: if the rules see one and the model doesn't, double-check.
  const HIGH_IMPACT = ["CANCEL", "RESCHEDULE", "DELETE_DATA", "STOP", "ARRIVED"];
  if (HIGH_IMPACT.includes(rules.intent) && e.intent !== rules.intent) r.push("intent_disagreement");
  return r;
}

function mergeSafety(base: Extraction, ...others: (Extraction | null | undefined)[]): Extraction {
  const out = { ...base };
  for (const o of others) {
    if (!o) continue;
    out.hasNonBookingContent ||= o.hasNonBookingContent;
    out.possibleEmergency ||= o.possibleEmergency;
  }
  return out;
}

/** Script decides Hindi vs Hinglish deterministically (models sometimes label Roman Hindi as "hi"). */
function fixLanguage(o: ExtractOutcome, text: string): ExtractOutcome {
  const e = o.extraction;
  if (DEVANAGARI.test(text)) e.language = "hi";
  else if (e.language === "hi") e.language = "hinglish";
  return o;
}

/** A time needs a number or time word in the message — models sometimes invent one ("morning" → 10:00). */
const TIME_EVIDENCE = /\d|[०-९]|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon|ek|do|teen|char|chaar|paanch|panch|che|chhe|saat|aath|nau|das|gyarah|barah|saade|sadhe|dedh|dhai|first|second|third|pehla|pehli|doosra|dusra|last|aakhri)\b|बजे|साढ़े|डेढ़|ढाई|दोपहर 12/i;
/** "10 se 11 ke beech", "between 10 and 11", "10-11", "10 से 11" → a range, so offer choices (never auto-book). */
const TIME_RANGE = /\b(between|beech|bich)\b|के बीच|बीच में|\b\d{1,2}\s*(se|to|-|–|से)\s*\d{1,2}\b(?![:./]\d)|\b\d{1,2}\s*(se|से)\s*\d{1,2}\s*(tak|तक|ke|के)/i;
/** Numbers that are durations, counts or money ("3 din se", "2 weeks", "₹500", "5 saal") are not evidence of a time. */
const NOT_A_TIME = /(₹|rs\.?\s*)\d+|\d+\s*(din|dino|dinon|days?|hafte|hafta|haftay|weeks?|mahine|mahina|months?|saal|sal|years?|yrs?|ghante|ghanta|hours?|hrs?|minutes?|mins?|baar|times|log|people|rupaye|rupees|rs|kg|tablets?|goli)\b|[0-9०-९]+\s*(दिन|हफ्ते|हफ़्ते|महीने|साल|घंटे|बार|रुपये)/gi;

function guardInventedTime(o: ExtractOutcome, text: string): ExtractOutcome {
  if (o.extraction.time && !TIME_EVIDENCE.test(text.replace(NOT_A_TIME, " "))) { o.extraction.time = null; o.extraction.timeQualifier = null; }
  if (o.extraction.time && TIME_RANGE.test(text) && o.extraction.timeQualifier !== "after" && o.extraction.timeQualifier !== "before") o.extraction.timeQualifier = "around";
  return o;
}

export async function extract(text: string, ctx: ExtractContext, cfg: CascadeConfig): Promise<ExtractOutcome> {
  return guardInventedTime(fixLanguage(await extractRaw(text, ctx, cfg), text), text);
}

async function extractRaw(text: string, ctx: ExtractContext, cfg: CascadeConfig): Promise<ExtractOutcome> {
  const calls: CallMeta[] = [];
  const rules = rulesExtract(text, ctx);
  if (!cfg.primary && !cfg.escalation) return { extraction: rules, source: "rules", escalated: false, reasons: [], calls };
  const user = renderUserTurn(text, ctx);

  let primary: Extraction | null = null;
  let reasons: string[] = [];
  if (cfg.primary) {
    const p = await tryModel(cfg.primary, user, cfg.timeoutMs, calls);
    if (p) {
      primary = postValidate(p.e, ctx);
      reasons = escalationReasons(primary, rules, text, cfg.minConfidence);
      // "safety_disagreement" alone is resolved by OR-merging, no need to pay for a second call.
      if (reasons.length === 0 || (reasons.length === 1 && reasons[0] === "safety_disagreement")) {
        return { extraction: mergeSafety(primary, rules), source: "primary", escalated: false, reasons, calls };
      }
    } else reasons = [calls.at(-1)?.error === "timeout" ? "primary_timeout" : "primary_failed"];
  }

  if (cfg.escalation) {
    const s = await tryModel(cfg.escalation, user, cfg.timeoutMs + 1500, calls);
    if (s) {
      const sup = postValidate(s.e, ctx);
      return { extraction: mergeSafety(sup, rules, primary), source: "escalation", escalated: !!cfg.primary, reasons, calls };
    }
    reasons.push("escalation_failed");
  }
  if (primary) return { extraction: mergeSafety(primary, rules), source: "primary", escalated: false, reasons, calls };
  return { extraction: rules, source: "rules", escalated: false, reasons, calls };
}
