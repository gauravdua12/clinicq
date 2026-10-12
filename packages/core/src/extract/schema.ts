import { z } from "zod";

// Structured result of understanding one patient message (docs/AI_EXTRACTION.md §3).
// This object is the ONLY thing derived from patient free text that may be persisted.

export const INTENTS = [
  "GREETING", "BOOK", "RESCHEDULE", "CANCEL", "STATUS", "ARRIVED", "MY_APPOINTMENTS",
  "CLINIC_INFO", "TALK_TO_STAFF", "MY_DATA", "DELETE_DATA", "STOP", "START",
  "CHANGE_NUMBER", "CHANGE_LANGUAGE", "PROVIDE", "AFFIRM", "DENY", "THANKS", "WAIT", "RUDE", "HELP", "OTHER",
] as const;
export const RELATIONS = ["SELF", "MOTHER", "FATHER", "SPOUSE", "SON", "DAUGHTER", "SIBLING", "GRANDPARENT", "OTHER"] as const;

export const Extraction = z.object({
  intent: z.enum(INTENTS),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  time: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  timeQualifier: z.enum(["exact", "around", "after", "before"]).nullable(),
  partOfDay: z.enum(["morning", "afternoon", "evening", "night"]).nullable(),
  forWhom: z.enum(["self", "existing_profile", "new_person", "unknown"]),
  profileRef: z.string().nullable(),
  newPersonName: z.string().nullable(),
  relation: z.enum(RELATIONS).nullable(),
  selfName: z.string().nullable(),
  phone: z.string().nullable(),
  visitType: z.enum(["NEW", "FOLLOW_UP", "REPORT_SHOW"]).nullable(),
  clinicInfoTopic: z.enum(["timings", "address", "fees", "other"]).nullable(),
  language: z.enum(["en", "hi", "hinglish"]),
  hasNonBookingContent: z.boolean(),
  possibleEmergency: z.boolean(),
  confidence: z.number().min(0).max(1),
});
export type Extraction = z.infer<typeof Extraction>;
export type Intent = (typeof INTENTS)[number];
export type Relation = (typeof RELATIONS)[number];

export const EXTRACTION_KEYS = Object.keys(Extraction.shape) as (keyof Extraction)[];

export function emptyExtraction(language: Extraction["language"] = "en"): Extraction {
  return {
    intent: "OTHER", date: null, time: null, timeQualifier: null, partOfDay: null,
    forWhom: "unknown", profileRef: null, newPersonName: null, relation: null, selfName: null,
    phone: null, visitType: null, clinicInfoTopic: null, language,
    hasNonBookingContent: false, possibleEmergency: false, confidence: 0,
  };
}

const NULLISH = new Set(["", "null", "none", "n/a", "na", "unknown", "undefined"]);

/**
 * Lenient normalisation of raw model JSON before strict validation, so that small
 * formatting slips ("18:00:00", "6:30", "NULL", missing keys) don't count as failures.
 * Returns { value, repaired } or null when the output is unusable.
 */
export function normalizeModelJson(raw: unknown): { value: Extraction; repaired: boolean } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...emptyExtraction() };
  let repaired = false;
  for (const k of EXTRACTION_KEYS) {
    if (!(k in src)) { repaired = true; continue; }
    let v = src[k];
    if (typeof v === "string" && NULLISH.has(v.trim().toLowerCase()) && k !== "intent" && k !== "language" && k !== "forWhom") { v = null; repaired = true; }
    out[k] = v;
  }
  const s = (k: string) => (typeof out[k] === "string" ? (out[k] as string).trim() : out[k]);
  for (const k of ["intent", "relation", "visitType"]) {
    const v = s(k);
    if (typeof v === "string") out[k] = v.toUpperCase().replace(/[\s-]/g, "_");
  }
  for (const k of ["timeQualifier", "partOfDay", "forWhom", "clinicInfoTopic", "language"]) {
    const v = s(k);
    if (typeof v === "string") out[k] = v.toLowerCase();
  }
  if (out.forWhom === "unknown" && src.forWhom === undefined) out.forWhom = "unknown";
  const t = out.time;
  if (typeof t === "string") {
    const m = t.match(/^(\d{1,2}):(\d{2})/);
    if (m) {
      const fixed = `${m[1]!.padStart(2, "0")}:${m[2]}`;
      if (fixed !== t) repaired = true;
      out.time = fixed;
    }
  }
  const d = out.date;
  if (typeof d === "string" && d.length > 10 && /^\d{4}-\d{2}-\d{2}/.test(d)) { out.date = d.slice(0, 10); repaired = true; }
  if (typeof out.phone === "string") {
    const digits = (out.phone as string).replace(/\D/g, "");
    out.phone = digits.length >= 10 ? digits.slice(-10) : null;
  }
  for (const k of ["hasNonBookingContent", "possibleEmergency"]) {
    if (typeof out[k] === "string") { out[k] = out[k] === "true"; repaired = true; }
    if (out[k] == null) out[k] = false;
  }
  if (typeof out.confidence === "string") out.confidence = Number(out.confidence);
  if (typeof out.confidence !== "number" || Number.isNaN(out.confidence)) { out.confidence = 0.6; repaired = true; }
  if ((out.confidence as number) > 1 && (out.confidence as number) <= 100) out.confidence = (out.confidence as number) / 100;
  const parsed = Extraction.safeParse(out);
  if (!parsed.success) return null;
  return { value: parsed.data, repaired };
}
