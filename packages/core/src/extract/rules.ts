import { addDays, toMin, fromMin, weekdayOf } from "../time";
import { matchesEmergency, mentionsHealthDetails } from "../safety";
import type { ExtractContext } from "./context";
import { emptyExtraction, type Extraction, type Intent, type Relation } from "./schema";

// Deterministic extractor: offline fallback, and the baseline in the model bake-off.

const DEVANAGARI = /[ऀ-ॿ]/;
const HINGLISH_WORDS = /\b(hai|hain|kal|aaj|parso|mujhe|mera|meri|mere|karna|karni|chahiye|baje|bje|kab|ke|ki|ko|liye|nahi|nahin|ho|raha|rahi|aap|kya|kaise|theek|thik|haan|ji|subah|shaam|sham|dopahar|raat|wala|wali|abhi|pahunch|dikhana|dikhane|badal|karo|kar|dena|do|tha|thi|bhi|aur|se|pehle|baad|aas|paas|lagbhag|mummy|papa|beta|beti|kitna|kitne|kahan|kaun|kaunsa|milega|milna|sakta|sakti|paunga|paungi|dobara|bukhar|dard)\b/i;

export function detectLanguage(text: string): Extraction["language"] {
  if (DEVANAGARI.test(text)) return "hi";
  return HINGLISH_WORDS.test(text) ? "hinglish" : "en";
}

const WEEKDAYS: [RegExp, number][] = [
  [/\b(sunday|sun|ravivar|itwar|itvaar)\b|रविवार|इतवार/i, 0],
  [/\b(monday|mon|somvar|somwar)\b|सोमवार/i, 1],
  [/\b(tuesday|tue|tues|mangalvar|mangalwar)\b|मंगलवार/i, 2],
  [/\b(wednesday|wed|budhvar|budhwar)\b|बुधवार/i, 3],
  [/\b(thursday|thu|thurs|guruvar|guruwar|veervar|brihaspativar)\b|गुरुवार|वीरवार/i, 4],
  [/\b(friday|fri|shukravar|shukrawar)\b|शुक्रवार/i, 5],
  [/\b(saturday|sat|shanivar|shaniwar)\b|शनिवार/i, 6],
];
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function nextWeekday(today: string, wd: number, forceNextWeek: boolean): string {
  const cur = weekdayOf(today);
  let diff = (wd - cur + 7) % 7;
  if (forceNextWeek && diff === 0) diff = 7;
  return addDays(today, diff);
}

function resolveDayOfMonth(today: string, day: number, month?: number): string | null {
  const [y, m] = today.split("-").map(Number) as [number, number];
  let year = y;
  let mon = month ?? m;
  const pad = (n: number) => String(n).padStart(2, "0");
  let cand = `${year}-${pad(mon)}-${pad(day)}`;
  if (Number.isNaN(Date.parse(cand)) || new Date(cand).getUTCDate() !== day) return null;
  if (cand < today) {
    if (month) year += 1;
    else { mon += 1; if (mon > 12) { mon = 1; year += 1; } }
    cand = `${year}-${pad(mon)}-${pad(day)}`;
  }
  return cand;
}

export function parseDate(text: string, today: string): string | null {
  const t = text.toLowerCase();
  if (/\b(day after tomorrow|parso|parson|parsoon)\b|परसों/.test(t)) return addDays(today, 2);
  if (/\b(tomorrow|tmrw|tmr|tommorow|tomorow|tommorrow)\b|कल/.test(t) && !/(कल|kal)\s*(aaya|aayi|gaya|gayi|aya|ayi)?\s*(tha|thi|the)\b/.test(t)) return addDays(today, 1);
  if (/\bkal\b/.test(t) && !/\bkal\s+(\w+\s+)?(tha|thi|the)\b/.test(t)) return addDays(today, 1);
  if (/\b(today|aaj|aj|tonight|abhi)\b|आज/.test(t)) return today;
  const dm = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:of\s+)?(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b/);
  if (dm) return resolveDayOfMonth(today, Number(dm[1]), MONTHS[dm[2]!]);
  const md = t.match(/\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (md) return resolveDayOfMonth(today, Number(md[2]), MONTHS[md[1]!]);
  const slash = t.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-]\d{2,4})?\b/);
  if (slash && Number(slash[2]) <= 12) return resolveDayOfMonth(today, Number(slash[1]), Number(slash[2]));
  const tareekh = t.match(/\b(\d{1,2})\s*(?:tareekh|tarikh|tarik|taarikh|th|st|nd|rd)\b|(\d{1,2})\s*तारीख/);
  if (tareekh) return resolveDayOfMonth(today, Number(tareekh[1] ?? tareekh[2]));
  for (const [re, wd] of WEEKDAYS) {
    if (re.test(t)) return nextWeekday(today, wd, /\bnext\s+\w*day\b|\bagle\b|\bagla\b/.test(t));
  }
  if (/\bnext week\b|agle hafte/.test(t)) return nextWeekday(today, 1, true);
  return null;
}

const POD: [RegExp, NonNullable<Extraction["partOfDay"]>][] = [
  [/\b(morning|subah|subha|savere|sawere)\b|सुबह/g, "morning"],
  [/\b(afternoon|dopahar|dopehar|dupahar)\b|दोपहर/g, "afternoon"],
  [/\b(evening|evng|shaam|sham|shām|eve)\b|शाम/g, "evening"],
  [/\b(night|raat|tonight)\b|रात/g, "night"],
];
/** Last-mentioned part of day wins ("ear pain since morning, slot this evening?" → evening). */
export function parsePartOfDay(text: string): Extraction["partOfDay"] {
  const t = text.toLowerCase().replace(/\bsince (morning|evening|night|afternoon)\b|subah se|shaam se|raat se/g, " ");
  let best: Extraction["partOfDay"] = null;
  let pos = -1;
  for (const [re, v] of POD) for (const m of t.matchAll(re)) if (m.index! > pos) { pos = m.index!; best = v; }
  return best;
}

function inSessions(min: number, ctx: ExtractContext): boolean {
  return ctx.sessions.some((s) => min >= toMin(s.start) - 60 && min <= toMin(s.end));
}

const NUM_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, che: 6, chhe: 6, chhah: 6, cheh: 6, saat: 7, sat: 7,
  aath: 8, aat: 8, nau: 9, das: 10, gyarah: 11, gyara: 11, barah: 12, bara: 12,
};
const NUM_RE = new RegExp(`\\b(${Object.keys(NUM_WORDS).join("|")})\\b(?=\\s*(baje|bje|pm|am|o'?clock|thirty|fifteen|forty|$))`, "gi");

export function parseTime(text: string, ctx: ExtractContext): { time: string | null; qualifier: Extraction["timeQualifier"] } {
  let t = text.toLowerCase().replace(/\s+/g, " ").replace(/\b12 noon\b|\bnoon\b/g, "12:00 pm");
  t = t.replace(NUM_RE, (w) => String(NUM_WORDS[w.toLowerCase()] ?? w));
  t = t.replace(/\b(\d{1,2})\s+thirty\b/g, "$1:30").replace(/\b(\d{1,2})\s+fifteen\b/g, "$1:15").replace(/\b(\d{1,2})\s+forty\s*five\b/g, "$1:45");
  const pod = parsePartOfDay(t);
  let qualifier: Extraction["timeQualifier"] = null;
  if (/(ke )?aas ?paas|around|approx|lagbhag|tak\b|ish\b|के आसपास|लगभग/.test(t)) qualifier = "around";
  else if (/\b(after|ke baad|baad)\b|के बाद/.test(t)) qualifier = "after";
  else if (/\b(before|se pehle|pehle)\b|से पहले/.test(t)) qualifier = "before";

  let h: number | null = null;
  let m = 0;
  let ampm: "am" | "pm" | null = null;
  const hm = t.match(/\b(\d{1,2})[:.](\d{2})\s*(am|pm|a\.m\.|p\.m\.)?/);
  const hOnly = t.match(/\b(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.|baje|bje|o'?clock|बजे)/);
  const devBaje = t.match(/(\d{1,2})\s*बजे/);
  const half = t.match(/\b(saade|sadhe|साढ़े)\s*(\d{1,2})\b/);
  if (hm) { h = Number(hm[1]); m = Number(hm[2]); ampm = hm[3]?.startsWith("p") ? "pm" : hm[3]?.startsWith("a") ? "am" : null; }
  else if (half) { h = Number(half[2]); m = 30; }
  else if (hOnly) { h = Number(hOnly[1]); ampm = hOnly[2]?.startsWith("p") ? "pm" : hOnly[2]?.startsWith("a") ? "am" : null; }
  else if (devBaje) { h = Number(devBaje[1]); }
  else if (t.match(/\b(tomorrow|tmrw|today|kal|aaj|parso|monday|tuesday|wednesday|thursday|friday|saturday|evening|evng|morning|shaam|sham|subah)\s+(?:at\s+)?(\d{1,2})\b(?![:.\d])(?!\s*(?:tareekh|tarikh|th|st|nd|rd|min|minute|din|day|days|log|people))/)) {
    h = Number(t.match(/\b(?:tomorrow|tmrw|today|kal|aaj|parso|monday|tuesday|wednesday|thursday|friday|saturday|evening|evng|morning|shaam|sham|subah)\s+(?:at\s+)?(\d{1,2})\b/)![1]);
  }
  else {
    // bare number answers ("6", "after 7") when the state expects a time
    const bare = t.match(/^(?:after |before |around |at )?(\d{1,2})(?: ?(?:baje|pm|am))?$/) ?? t.match(/\b(?:after|before|around|at|ke baad)\s+(\d{1,2})\b/);
    const expectsTime = /BK_WHEN|BK_PICK_SLOT|WALKIN_STAFF_TIME|RS_/.test(ctx.state);
    if (bare && (expectsTime || /\b(after|before|around|at)\b/.test(t)) && Number(bare[1]) <= 23) h = Number(bare[1]);
  }
  if (h === null || h > 23 || m > 59) return { time: null, qualifier };
  if (ampm === "pm" && h < 12) h += 12;
  else if (ampm === "am" && h === 12) h = 0;
  else if (!ampm && h <= 12) {
    if (pod === "evening" || pod === "night" || (pod === "afternoon" && h < 12)) { if (h < 12) h += 12; }
    else if (pod === "morning") { if (h === 12) h = 0; }
    else if (h < 12) {
      const am = h * 60 + m;
      const pm = (h + 12) * 60 + m;
      if (!inSessions(am, ctx) && inSessions(pm, ctx)) h += 12;
      else if (h <= 7) h += 12; // "6", "7" without context → evening clinic hours
    }
  }
  return { time: fromMin(h * 60 + m), qualifier: qualifier ?? "exact" };
}

const REL_WORDS: [RegExp, Relation][] = [
  [/\b(mummy|mumma|mom|mother|maa|mataji|mother-in-law|saas)\b|माँ|मां|मम्मी|माता/i, "MOTHER"],
  [/\b(papa|dad|daddy|father|pitaji|pita ji|father-in-law|sasur)\b|पापा|पिता/i, "FATHER"],
  [/\b(wife|husband|patni|pati|missus|mrs)\b|पत्नी|पति/i, "SPOUSE"],
  [/\b(son|beta|bete|boy)\b|बेटा|बेटे/i, "SON"],
  [/\b(daughter|beti|bitiya|girl)\b|बेटी/i, "DAUGHTER"],
  [/\b(brother|sister|bhai|bhaiya|behen|bahan|didi)\b|भाई|बहन|दीदी/i, "SIBLING"],
  [/\b(dadi|nani|dada|nana|grandmother|grandfather|grandma|grandpa)\b|दादी|नानी|दादा|नाना/i, "GRANDPARENT"],
];

const NAME_STOP = new Set(["the", "my", "for", "and", "on", "at", "to", "ke", "ki", "ka", "liye", "hai", "ko", "is", "tomorrow", "today", "kal", "aaj", "appointment", "please", "pls", "ji", "evening", "morning", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "after", "before", "around"]);

function captureName(after: string): string | null {
  const words = after.trim().split(/[\s,.]+/).filter(Boolean);
  const out: string[] = [];
  for (const w of words) {
    if (!/^[A-Za-z][A-Za-z.'-]*$/.test(w) || NAME_STOP.has(w.toLowerCase())) break;
    out.push(w[0]!.toUpperCase() + w.slice(1).toLowerCase());
    if (out.length === 3) break;
  }
  return out.length ? out.join(" ") : null;
}

function intentOf(t: string, ctx: ExtractContext, extracted: { time: string | null; date: string | null; name: string | null; phone: string | null; relation: Relation | null; visit: Extraction["visitType"]; pod: Extraction["partOfDay"]; self: boolean }): Intent {
  const s = t.trim().toLowerCase();
  const has = (re: RegExp) => re.test(s);
  if (has(/\b(delete|erase|remove|hatao|hata do|mita)\b.*\b(data|details|information|jankari)|\b(data|details|jankari)\b.*\b(delete|hatao|hata|remove|mita)/)) return "DELETE_DATA";
  if (has(/\b(my|mera|meri)\s+(data|details|information|jankari)\b/)) return "MY_DATA";
  if (has(/^(stop|unsubscribe)\b|\bstop sending\b|\b(band karo|mat bhejo|messages? band)\b/)) return "STOP";
  if (has(/^start$/)) return "START";
  if (has(/\b(change|update|badal)\w*\s+(my\s+)?(number|mobile|phone)|\b(number|mobile)\s+(change|badal)|\bwrong number\b|\bnaya number\b/)) return "CHANGE_NUMBER";
  if (has(/\b(hindi|english|angrezi)\s+(me|mein|main|में)\b|\bin (hindi|english)\b|\blanguage\b/)) return "CHANGE_LANGUAGE";
  if (has(/कैंसल|रद्द|\b(cancel|radd)\b|nahi aa (paunga|paungi|payenge|sakta|sakti|sakte)|nahi aana|won'?t (be able to )?come|can'?t come|cannot come|not coming/)) return "CANCEL";
  if (has(/\b(reschedule|re-schedule|shift|prepone|postpone|badal|badalna|aage kar|piche kar)\b|change (the |my )?(time|date|appointment)|time change|move (it|my)/)) return "RESCHEDULE";
  if (has(/\b(reached|arrived|i am here|i'm here|im here|pahunch|pohoch|pahuch|aa gaya|aa gayi|aa gaye|outside the clinic|at the clinic|at clinic|reception par)\b|पहुँच|पहुंच/)) return "ARRIVED";
  if (has(/\b(status|kab aayega|kab ayega|kab aaega|kitna time|kitni der|how long|how many (people|patients)|my turn|meri baari|meri bari|number kab|kitne log|position|queue)\b|कब आएगा|मेरी बारी/)) return "STATUS";
  if (has(/\b(my appointments?|my bookings?|kab ka hai|appointment kab hai|when is my)\b|appointment (confirm|pakka) (hai|h)\b/)) return "MY_APPOINTMENTS";
  if (has(/\b(timing|timings|open|khula|khulta|band hai kya|closed|address|location|kahan hai|kaha hai|where is|fees?|charges?|kitne paise|kitna lagega|consultation fee)\b|पता|फीस|समय क्या/) && !extracted.time && !has(/\bbook|appointment\b/)) return "CLINIC_INFO";
  if (has(/\b(talk to|speak to|call me|call back|receptionist|baat kar|baat karni|baat karna|human|real person|staff se)\b/)) return "TALK_TO_STAFF";
  if (has(/\b(thank|thanks|thx|thnx|dhanyavaad|dhanyawad|shukriya)\b|धन्यवाद|शुक्रिया/)) return "THANKS";
  if (has(/\b(appointment|appoinment|apointment|appt|book|booking|slot|milna|milne|dikhana|dikhane|dikhani|consult|checkup|check up|check-up|visit|time chahiye|time do|aana hai|aa sakta|aa sakti|mil sakta|mil sakti|doctor se)\b|अपॉइंटमेंट|दिखाना|मिलना/)) {
    if (/BK_PICK_SLOT/.test(ctx.state) && extracted.time) return "PROVIDE";
    return /BK_|RS_|WALKIN/.test(ctx.state) && !has(/\b(book|booking|appointment)\b|\b(new|naya|nayi|another|dusra|doosra|ek aur)\b/) ? "PROVIDE" : "BOOK";
  }
  if (has(/^(hi+|hello|hey|hlo|namaste|namaskar|good (morning|afternoon|evening))\b/) && s.split(/\s+/).length <= 4) return "GREETING";
  if (has(/^(no|nahi|nahin|na|nope|nah|mat)\b/)) return extracted.time || extracted.date ? "DENY" : "DENY";
  if (has(/^(yes|haan|ha|han|haa|ok|okay|okk|theek|thik|sure|done|confirm|ji|ji haan|yep|yup|chalega|sahi)\b/)) return "AFFIRM";
  const answering = ctx.state !== "IDLE";
  if (extracted.time || extracted.date || extracted.phone || extracted.name || extracted.relation || extracted.visit || extracted.pod || extracted.self) {
    if (answering) return "PROVIDE";
    if (extracted.time || extracted.date || extracted.pod) return "BOOK";
    return "PROVIDE";
  }
  return "OTHER";
}

export function rulesExtract(text: string, ctx: ExtractContext): Extraction {
  const t = text.trim();
  const lower = t.toLowerCase();
  const out = emptyExtraction(detectLanguage(t));
  out.date = parseDate(lower, ctx.today);
  const tm = parseTime(lower, ctx);
  out.time = tm.time;
  out.timeQualifier = tm.time ? tm.qualifier : null;
  out.partOfDay = parsePartOfDay(lower);

  const phone = t.replace(/[\s-]/g, "").match(/(?:\+?91)?([6-9]\d{9})\b/);
  out.phone = phone ? phone[1]! : null;
  if (out.phone && out.time === null) { /* phone digits must not be read as time */ }

  if (/\b(follow ?up|followup|dobara|phir se|review|again)\b/i.test(lower)) out.visitType = "FOLLOW_UP";
  else if (/\breports?\b|रिपोर्ट/i.test(lower)) out.visitType = "REPORT_SHOW";
  else if (/\b(first time|new consultation|new patient|pehli baar|nayi consultation)\b/i.test(lower)) out.visitType = "NEW";

  let relation: Relation | null = null;
  for (const [re, rel] of REL_WORDS) if (re.test(t)) { relation = rel; break; }
  const self = /\b(for me|myself|mere liye|mera|mujhe|apne liye|for myself|i want|i need|me)\b|मुझे|मेरे लिए/i.test(lower);
  if (relation) {
    out.relation = relation;
    const prof = ctx.profiles.find((p) => p.relation === relation);
    out.forWhom = prof ? "existing_profile" : "new_person";
    out.profileRef = prof?.ref ?? null;
    const nm = t.match(new RegExp(`(?:mummy|mumma|mom|mother|maa|papa|dad|father|wife|husband|son|beta|daughter|beti|brother|sister|bhai|didi|dadi|nani|dada|nana)\\s*,?\\s*(?:named\\s+|called\\s+)?([A-Za-z][A-Za-z ]*)`, "i"));
    if (nm && !prof) out.newPersonName = captureName(nm[1]!);
  } else if (self) {
    out.forWhom = "self";
    out.relation = "SELF";
    out.profileRef = ctx.profiles.find((p) => p.relation === "SELF")?.ref ?? null;
  }
  const myName = t.match(/\b(?:my name is|i am|i'm|mera naam|naam)\s+([A-Za-z][A-Za-z ]+?)(?:\s+(?:hai|h))?$/i) ?? t.match(/\b(?:my name is|mera naam)\s+([A-Za-z][A-Za-z ]+)/i);
  if (myName) { out.selfName = captureName(myName[1]!); }
  else if (/WALKIN_ASK_NAME|BK_NAME|ASK_NAME/.test(ctx.state) && /^[A-Za-z][A-Za-z .]{1,40}$/.test(t) && t.split(/\s+/).length <= 4) {
    const nm = captureName(t);
    if (ctx.state.includes("BK_NAME")) { out.newPersonName = nm; out.forWhom = "new_person"; }
    else out.selfName = nm;
  }
  const forName = t.match(/\bfor\s+([A-Z][a-z]+)\b/);
  if (!out.newPersonName && !out.selfName && forName && !NAME_STOP.has(forName[1]!.toLowerCase()) && out.forWhom !== "self") {
    out.newPersonName = forName[1]!;
    if (out.forWhom === "unknown") out.forWhom = "new_person";
  }

  if (/\b(timing|timings|open|khula|closed|band|hours)\b|समय/i.test(lower)) out.clinicInfoTopic = "timings";
  else if (/\b(address|location|kahan|where|map)\b|पता/i.test(lower)) out.clinicInfoTopic = "address";
  else if (/\b(fees?|charges?|paise|cost|kitna lagega)\b|फीस/i.test(lower)) out.clinicInfoTopic = "fees";

  // "the second one" / "pehla wala" → pick from the offered times
  if (!out.time && ctx.offeredTimes?.length) {
    const ord = lower.match(/\b(first|1st|pehla|pehli|pahla|second|2nd|doosra|dusra|doosri|dusri|third|3rd|teesra|last|aakhri)\b/);
    if (ord) {
      const idx = /first|1st|pehl|pahl/.test(ord[1]!) ? 0 : /second|2nd|doos|dus/.test(ord[1]!) ? 1 : /third|3rd|tees/.test(ord[1]!) ? 2 : ctx.offeredTimes.length - 1;
      const pick = ctx.offeredTimes[idx];
      if (pick) { out.time = pick; out.timeQualifier = "exact"; }
    }
  }
  out.intent = intentOf(t, ctx, { time: out.time, date: out.date, name: out.newPersonName ?? out.selfName, phone: out.phone, relation, visit: out.visitType, pod: out.partOfDay, self: out.forWhom === "self" });
  if (out.intent !== "CLINIC_INFO") out.clinicInfoTopic = null;
  if (out.intent === "CHANGE_LANGUAGE") out.language = /\bhindi\b|हिंदी/i.test(lower) ? "hi" : /\benglish\b/i.test(lower) ? "en" : out.language;
  out.possibleEmergency = matchesEmergency(t);
  out.hasNonBookingContent = mentionsHealthDetails(t);
  out.confidence = out.intent === "OTHER" ? 0.2 : 0.5;
  return out;
}
