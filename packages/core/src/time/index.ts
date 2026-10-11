import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

// Clinic-local calendar helpers. Core logic works with local date strings ("YYYY-MM-DD")
// and minutes-from-midnight; conversion to UTC instants happens only at the DB boundary.

export const DEFAULT_TZ = "Asia/Kolkata";

export function localDate(d: Date, tz = DEFAULT_TZ): string {
  return formatInTimeZone(d, tz, "yyyy-MM-dd");
}

export function localTime(d: Date, tz = DEFAULT_TZ): string {
  return formatInTimeZone(d, tz, "HH:mm");
}

export function localMinutes(d: Date, tz = DEFAULT_TZ): number {
  return toMin(localTime(d, tz));
}

/** Local date + "HH:MM" (or minutes) in the clinic TZ → UTC Date. */
export function toInstant(date: string, time: string | number, tz = DEFAULT_TZ): Date {
  const hhmm = typeof time === "number" ? fromMin(time) : time;
  return fromZonedTime(`${date}T${hhmm}:00`, tz);
}

export function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function fromMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 0 = Sunday … 6 = Saturday, for a local date string. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}

/** DB @db.Date values are stored as UTC midnight of the local date. */
export function dateToDb(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}
export function dateFromDb(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const WD_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WD_EN_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WD_HI = ["रवि", "सोम", "मंगल", "बुध", "गुरु", "शुक्र", "शनि"];
const WD_HI_LONG = ["रविवार", "सोमवार", "मंगलवार", "बुधवार", "गुरुवार", "शुक्रवार", "शनिवार"];
const MON_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MON_HI = ["जन", "फ़र", "मार्च", "अप्रैल", "मई", "जून", "जुला", "अग", "सित", "अक्टू", "नव", "दिस"];

export type Lang = "en" | "hi" | "hinglish";

/** "Sat 11 Oct" */
export function fmtDayShort(date: string, lang: Lang = "en"): string {
  const wd = weekdayOf(date);
  const [, m, d] = date.split("-").map(Number);
  if (lang === "hi") return `${WD_HI[wd]} ${d} ${MON_HI[(m ?? 1) - 1]}`;
  return `${WD_EN[wd]} ${d} ${MON_EN[(m ?? 1) - 1]}`;
}

/** "11 Oct" */
export function fmtDate(date: string, lang: Lang = "en"): string {
  const [, m, d] = date.split("-").map(Number);
  return lang === "hi" ? `${d} ${MON_HI[(m ?? 1) - 1]}` : `${d} ${MON_EN[(m ?? 1) - 1]}`;
}

/** "tomorrow" / "Monday" / "Sat 18 Oct" relative to today. */
export function fmtDayLabel(date: string, today: string, lang: Lang = "en"): string {
  const diff = daysBetween(today, date);
  const wd = weekdayOf(date);
  if (lang === "hi") {
    if (diff === 0) return "आज";
    if (diff === 1) return "कल";
    if (diff > 1 && diff < 7) return WD_HI_LONG[wd]!;
    return fmtDayShort(date, lang);
  }
  if (lang === "hinglish") {
    if (diff === 0) return "aaj";
    if (diff === 1) return "kal";
    if (diff > 1 && diff < 7) return WD_EN_LONG[wd]!;
    return fmtDayShort(date, "en");
  }
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff > 1 && diff < 7) return WD_EN_LONG[wd]!;
  return fmtDayShort(date, "en");
}

/** 1090 → "6:10 PM" */
export function fmtTime(min: number | string): string {
  const m = typeof min === "string" ? toMin(min) : min;
  const h24 = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${mm} ${ampm}`;
}

export function partOfDayOf(min: number): "morning" | "afternoon" | "evening" | "night" {
  if (min < 12 * 60) return "morning";
  if (min < 16 * 60) return "afternoon";
  if (min < 20 * 60) return "evening";
  return "night";
}

export const PART_OF_DAY_RANGE: Record<"morning" | "afternoon" | "evening" | "night", [number, number]> = {
  morning: [0, 12 * 60],
  afternoon: [12 * 60, 16 * 60],
  evening: [16 * 60, 20 * 60 + 30],
  night: [20 * 60, 24 * 60],
};

export function weekdayName(date: string): string {
  return WD_EN_LONG[weekdayOf(date)]!;
}
