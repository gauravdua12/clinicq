import type { ExtractContext, Extraction, Intent } from "@clinicq/core/extract/index";

// Extraction evaluation set (docs/AI_EXTRACTION.md §7).
// Today = Fri 2026-10-09 12:05 IST (real calendar: 10 Oct = Sat, 12 Oct = Mon). Sessions Mon–Sat Morning 10:00–13:00, Evening 17:00–20:00; Sunday closed.
// Default profiles: P1 SELF, P2 MOTHER. Only fields listed in `expect` are scored.

type Expect = Partial<Omit<Extraction, "intent" | "forWhom" | "confidence">> & {
  intent?: Intent | Intent[];
  forWhom?: Extraction["forWhom"] | Extraction["forWhom"][];
};

export interface EvalCase {
  id: string;
  cat: "book" | "provide" | "manage" | "info" | "privacy" | "medical" | "emergency" | "control" | "hindi" | "noisy";
  text: string;
  ctx?: Partial<ExtractContext>;
  expect: Expect;
}

export const BASE_CTX: ExtractContext = {
  today: "2026-10-09",
  nowTime: "12:05",
  sessions: [1, 2, 3, 4, 5, 6].flatMap((wd) => [
    { weekday: wd, label: "Morning", start: "10:00", end: "13:00" },
    { weekday: wd, label: "Evening", start: "17:00", end: "20:00" },
  ]),
  profiles: [{ ref: "P1", relation: "SELF" }, { ref: "P2", relation: "MOTHER" }],
  state: "IDLE",
};

const S = (state: string, question?: string, offeredTimes?: string[]): Partial<ExtractContext> => ({ state, question, offeredTimes });
const SON = { profiles: [{ ref: "P1", relation: "SELF" as const }, { ref: "P2", relation: "MOTHER" as const }, { ref: "P3", relation: "SON" as const }] };
const NOPROF = { profiles: [] };

export const CASES: EvalCase[] = [
  // ── Booking requests ─────────────────────────────────────────────
  { id: "b01", cat: "book", text: "need appointment tomorrow evening for my mother", expect: { intent: "BOOK", date: "2026-10-10", partOfDay: "evening", forWhom: "existing_profile", profileRef: "P2", hasNonBookingContent: false } },
  { id: "b02", cat: "book", text: "kal shaam 6 baje ke aas paas mummy ke liye", expect: { intent: "BOOK", date: "2026-10-10", time: "18:00", timeQualifier: "around", forWhom: "existing_profile", profileRef: "P2", language: "hinglish" } },
  { id: "b03", cat: "book", text: "Hi, I want to book appointment", expect: { intent: "BOOK", date: null, time: null } },
  { id: "b04", cat: "book", text: "Monday morning", expect: { intent: ["BOOK", "PROVIDE"], date: "2026-10-12", partOfDay: "morning", time: null } },
  { id: "b05", cat: "book", text: "parso subah 11 baje papa ke liye", ctx: NOPROF, expect: { intent: "BOOK", date: "2026-10-11", time: "11:00", forWhom: "new_person", relation: "FATHER" } },
  { id: "b06", cat: "book", text: "appointment for my son Aarav on Saturday after 5", expect: { intent: "BOOK", date: "2026-10-10", time: "17:00", timeQualifier: "after", forWhom: "new_person", relation: "SON", newPersonName: "Aarav" } },
  { id: "b07", cat: "book", text: "anytime after 7 tomorrow", expect: { intent: ["BOOK", "PROVIDE"], date: "2026-10-10", time: "19:00", timeQualifier: "after" } },
  { id: "b08", cat: "book", text: "aaj ka mil sakta hai kya", expect: { intent: "BOOK", date: "2026-10-09", language: "hinglish" } },
  { id: "b09", cat: "book", text: "Can I come on 15th October at 10:30 am?", expect: { intent: "BOOK", date: "2026-10-15", time: "10:30" } },
  { id: "b10", cat: "book", text: "book me for tuesday 6pm", expect: { intent: "BOOK", date: "2026-10-13", time: "18:00", forWhom: "self" } },
  { id: "b11", cat: "book", text: "Doctor sahab se milna hai Wednesday ko shaam mein", expect: { intent: "BOOK", date: "2026-10-14", partOfDay: "evening", language: "hinglish" } },
  { id: "b12", cat: "book", text: "I need a follow up visit next Monday", expect: { intent: "BOOK", date: "2026-10-12", visitType: "FOLLOW_UP", forWhom: "self" } },
  { id: "b13", cat: "book", text: "kal aaya tha, dobara aana hai Tuesday ko", expect: { intent: "BOOK", date: "2026-10-13", visitType: "FOLLOW_UP" } },
  { id: "b14", cat: "book", text: "report dikhani hai kal subah", expect: { intent: "BOOK", date: "2026-10-10", partOfDay: "morning", visitType: "REPORT_SHOW", hasNonBookingContent: false } },
  { id: "b15", cat: "book", text: "Appointment for my wife Priya tomorrow 11am", ctx: NOPROF, expect: { intent: "BOOK", date: "2026-10-10", time: "11:00", forWhom: "new_person", relation: "SPOUSE", newPersonName: "Priya" } },
  { id: "b16", cat: "book", text: "beti ke liye time chahiye, saturday shaam 5:30", ctx: NOPROF, expect: { intent: "BOOK", date: "2026-10-10", time: "17:30", forWhom: "new_person", relation: "DAUGHTER" } },
  { id: "b17", cat: "book", text: "Aarav ke liye kal ka appointment", ctx: SON, expect: { intent: "BOOK", date: "2026-10-10", forWhom: ["new_person", "existing_profile"] } }, // names never reach the model; server matches "Aarav" locally, or the model maps the only son (P3)
  { id: "b18", cat: "book", text: "book for my son tomorrow evening", ctx: SON, expect: { intent: "BOOK", date: "2026-10-10", partOfDay: "evening", forWhom: "existing_profile", profileRef: "P3" } },
  { id: "b19", cat: "book", text: "first time visit, can I get a slot on 20th Oct?", expect: { intent: "BOOK", date: "2026-10-20", visitType: "NEW" } },
  { id: "b20", cat: "book", text: "is there any slot today evening", expect: { intent: "BOOK", date: "2026-10-09", partOfDay: "evening" } },
  { id: "b21", cat: "book", text: "next week Thursday morning 10 baje", expect: { intent: "BOOK", date: "2026-10-15", time: "10:00" } },
  { id: "b22", cat: "book", text: "can i see the doctor before 11 on monday", expect: { intent: "BOOK", date: "2026-10-12", time: "11:00", timeQualifier: "before" } },
  { id: "b23", cat: "book", text: "Appointment chahiye", expect: { intent: "BOOK", date: null, time: null, language: "hinglish" } },
  { id: "b24", cat: "book", text: "mujhe aur meri mummy dono ko dikhana hai kal", expect: { intent: "BOOK", date: "2026-10-10" } },
  { id: "b25", cat: "book", text: "slot on 1 nov morning?", expect: { intent: "BOOK", date: "2026-11-01", partOfDay: "morning" } },
  { id: "b26", cat: "book", text: "Hello doctor, I would like to consult on Monday around 7 pm", expect: { intent: "BOOK", date: "2026-10-12", time: "19:00", timeQualifier: "around" } },
  { id: "b27", cat: "book", text: "dadi ko dikhana hai somvar ko", ctx: NOPROF, expect: { intent: "BOOK", date: "2026-10-12", forWhom: "new_person", relation: "GRANDPARENT" } },
  { id: "b28", cat: "book", text: "need checkup for myself tomorrow 12 noon", expect: { intent: "BOOK", date: "2026-10-10", time: "12:00", forWhom: "self" } },

  // ── Answers within a conversation state ──────────────────────────
  { id: "p01", cat: "provide", text: "6:10", ctx: S("BK_PICK_SLOT", "choose a time", ["17:50", "18:10"]), expect: { intent: "PROVIDE", time: "18:10" } },
  { id: "p02", cat: "provide", text: "6", ctx: S("BK_WHEN", "day and time"), expect: { intent: "PROVIDE", time: "18:00" } },
  { id: "p03", cat: "provide", text: "next Monday", ctx: S("BK_WHEN", "day and time"), expect: { intent: "PROVIDE", date: "2026-10-12" } },
  { id: "p04", cat: "provide", text: "9876543210", ctx: S("AWAIT_ALT_NUMBER", "10-digit mobile number"), expect: { intent: "PROVIDE", phone: "9876543210" } },
  { id: "p05", cat: "provide", text: "my name is Anil Verma", ctx: S("WALKIN_ASK_NAME", "patient's name"), expect: { intent: "PROVIDE", selfName: "Anil Verma" } },
  { id: "p06", cat: "provide", text: "Anil Verma", ctx: S("WALKIN_ASK_NAME", "patient's name"), expect: { intent: "PROVIDE", selfName: "Anil Verma" } },
  { id: "p07", cat: "provide", text: "for wife", ctx: { ...S("BK_WHO", "for you or someone else"), ...NOPROF }, expect: { intent: "PROVIDE", forWhom: "new_person", relation: "SPOUSE" } },
  { id: "p08", cat: "provide", text: "follow up", ctx: S("BK_VISIT_TYPE", "new consultation or follow-up"), expect: { intent: "PROVIDE", visitType: "FOLLOW_UP" } },
  { id: "p09", cat: "provide", text: "report dikhani hai", ctx: S("BK_VISIT_TYPE", "new consultation or follow-up"), expect: { intent: "PROVIDE", visitType: "REPORT_SHOW", hasNonBookingContent: false } },
  { id: "p10", cat: "provide", text: "haan theek hai", ctx: S("CX_CONFIRM", "cancel the appointment?"), expect: { intent: "AFFIRM" } },
  { id: "p11", cat: "provide", text: "no, I need 6 pm only", ctx: S("BK_PICK_SLOT", "choose a time", ["18:30", "19:10"]), expect: { intent: ["DENY", "PROVIDE"], time: "18:00" } },
  { id: "p12", cat: "provide", text: "ok", ctx: S("BK_PICK_SLOT", "shall I book 10:20 AM?", ["10:20"]), expect: { intent: "AFFIRM" } },
  { id: "p13", cat: "provide", text: "6:30 chalega?", ctx: S("BK_PICK_SLOT", "choose a time", ["17:50", "18:10"]), expect: { intent: "PROVIDE", time: "18:30" } },
  { id: "p14", cat: "provide", text: "same day but evening", ctx: S("BK_WHEN", "new day and time for reschedule"), expect: { intent: "PROVIDE", partOfDay: "evening" } },
  { id: "p15", cat: "provide", text: "for me", ctx: S("BK_WHO", "for you or someone else"), expect: { intent: "PROVIDE", forWhom: "self", profileRef: "P1" } },
  { id: "p16", cat: "provide", text: "mummy", ctx: S("BK_WHO", "for you or someone else"), expect: { intent: "PROVIDE", forWhom: "existing_profile", profileRef: "P2" } },
  { id: "p17", cat: "provide", text: "my son, his name is Kabir", ctx: { ...S("BK_WHO", "for you or someone else"), ...NOPROF }, expect: { intent: "PROVIDE", forWhom: "new_person", relation: "SON", newPersonName: "Kabir" } },
  { id: "p18", cat: "provide", text: "subah 10:40", ctx: S("BK_WHEN", "day and time"), expect: { intent: "PROVIDE", time: "10:40" } },
  { id: "p19", cat: "provide", text: "nahi", ctx: S("CX_CONFIRM", "cancel the appointment?"), expect: { intent: "DENY" } },
  { id: "p20", cat: "provide", text: "the second one", ctx: S("BK_PICK_SLOT", "choose a time", ["17:50", "18:10"]), expect: { intent: ["PROVIDE", "AFFIRM"], time: "18:10" } },
  { id: "p21", cat: "provide", text: "7:50 PM", ctx: S("WALKIN_STAFF_TIME", "which time to give the walk-in"), expect: { intent: "PROVIDE", time: "19:50" } },
  { id: "p22", cat: "provide", text: "pehli baar aa raha hoon", ctx: S("BK_VISIT_TYPE", "new consultation or follow-up"), expect: { intent: "PROVIDE", visitType: "NEW" } },
  { id: "p23", cat: "provide", text: "Sunita", ctx: { ...S("BK_NAME", "the patient's name"), ...NOPROF }, expect: { intent: "PROVIDE", newPersonName: "Sunita" } },
  { id: "p24", cat: "provide", text: "after 5", ctx: S("BK_WHEN", "day and time"), expect: { intent: "PROVIDE", time: "17:00", timeQualifier: "after" } },

  // ── Managing bookings / queue ────────────────────────────────────
  { id: "m01", cat: "manage", text: "cancel my appointment", expect: { intent: "CANCEL" } },
  { id: "m02", cat: "manage", text: "nahi aa paunga kal", expect: { intent: "CANCEL", date: "2026-10-10" } },
  { id: "m03", cat: "manage", text: "shift it to Monday evening", expect: { intent: "RESCHEDULE", date: "2026-10-12", partOfDay: "evening" } },
  { id: "m04", cat: "manage", text: "time change karna hai, 7 baje kar do", expect: { intent: "RESCHEDULE", time: "19:00" } },
  { id: "m05", cat: "manage", text: "mera number kab aayega?", expect: { intent: "STATUS", language: "hinglish" } },
  { id: "m06", cat: "manage", text: "how many people before me", expect: { intent: "STATUS" } },
  { id: "m07", cat: "manage", text: "reached", expect: { intent: "ARRIVED" } },
  { id: "m08", cat: "manage", text: "clinic pahunch gaya hoon", expect: { intent: "ARRIVED" } },
  { id: "m09", cat: "manage", text: "when is my appointment?", expect: { intent: "MY_APPOINTMENTS" } },
  { id: "m10", cat: "manage", text: "kitna time aur lagega", expect: { intent: "STATUS" } },
  { id: "m11", cat: "manage", text: "I am outside the clinic", expect: { intent: "ARRIVED" } },
  { id: "m12", cat: "manage", text: "please cancel mummy's appointment", expect: { intent: "CANCEL", forWhom: "existing_profile", profileRef: "P2" } },
  { id: "m13", cat: "manage", text: "can we postpone to 20th", expect: { intent: "RESCHEDULE", date: "2026-10-20" } },
  { id: "m14", cat: "manage", text: "I will be 15 min late", expect: { intent: ["OTHER", "STATUS", "PROVIDE"], hasNonBookingContent: false } },
  { id: "m15", cat: "manage", text: "my turn kab hai", expect: { intent: "STATUS" } },
  { id: "m16", cat: "manage", text: "Can't come today, sorry", expect: { intent: "CANCEL", date: "2026-10-09" } },

  // ── Clinic info / misc ───────────────────────────────────────────
  { id: "i01", cat: "info", text: "what are the timings on Sunday", expect: { intent: "CLINIC_INFO", clinicInfoTopic: "timings" } },
  { id: "i02", cat: "info", text: "fees kitni hai", expect: { intent: "CLINIC_INFO", clinicInfoTopic: "fees" } },
  { id: "i03", cat: "info", text: "clinic ka address bhejo", expect: { intent: "CLINIC_INFO", clinicInfoTopic: "address" } },
  { id: "i04", cat: "info", text: "talk to receptionist", expect: { intent: "TALK_TO_STAFF" } },
  { id: "i05", cat: "info", text: "thank you so much", expect: { intent: "THANKS" } },
  { id: "i06", cat: "info", text: "hindi mein baat karo", expect: { intent: "CHANGE_LANGUAGE" } },
  { id: "i07", cat: "info", text: "Hello", expect: { intent: "GREETING" } },
  { id: "i08", cat: "info", text: "namaste ji", expect: { intent: "GREETING" } },
  { id: "i09", cat: "info", text: "is the clinic open on Diwali?", expect: { intent: "CLINIC_INFO", clinicInfoTopic: "timings" } },
  { id: "i10", cat: "info", text: "please call me back", expect: { intent: "TALK_TO_STAFF" } },
  { id: "i11", cat: "info", text: "do you accept UPI?", expect: { intent: ["CLINIC_INFO", "OTHER"], clinicInfoTopic: ["fees", "other"] as never } },
  { id: "i12", cat: "info", text: "where is the clinic exactly", expect: { intent: "CLINIC_INFO", clinicInfoTopic: "address" } },

  // ── Privacy commands ─────────────────────────────────────────────
  { id: "v01", cat: "privacy", text: "delete my data", expect: { intent: "DELETE_DATA" } },
  { id: "v02", cat: "privacy", text: "stop sending messages", expect: { intent: "STOP" } },
  { id: "v03", cat: "privacy", text: "show my data", expect: { intent: "MY_DATA" } },
  { id: "v04", cat: "privacy", text: "mera data hata do", expect: { intent: "DELETE_DATA" } },
  { id: "v05", cat: "privacy", text: "I want to change my number", expect: { intent: "CHANGE_NUMBER" } },
  { id: "v06", cat: "privacy", text: "STOP", expect: { intent: "STOP" } },

  // ── Health details (must be flagged; booking info still extracted) ─
  { id: "h01", cat: "medical", text: "I have fever since 3 days, which slot is better", ctx: S("BK_PICK_SLOT", "choose a time", ["10:20", "11:00"]), expect: { hasNonBookingContent: true, possibleEmergency: false } },
  { id: "h02", cat: "medical", text: "kal subah appointment chahiye, bukhar hai teen din se", expect: { intent: "BOOK", date: "2026-10-10", partOfDay: "morning", hasNonBookingContent: true, possibleEmergency: false } },
  { id: "h03", cat: "medical", text: "sugar high hai, medicine change karni hai, follow up chahiye", expect: { intent: "BOOK", visitType: "FOLLOW_UP", hasNonBookingContent: true } },
  { id: "h04", cat: "medical", text: "can you tell me what medicine to take for cough", expect: { intent: "OTHER", hasNonBookingContent: true } },
  { id: "h05", cat: "medical", text: "my BP was 160/100 this morning, need appointment today", expect: { intent: "BOOK", date: "2026-10-09", hasNonBookingContent: true } },
  { id: "h06", cat: "medical", text: "beti ko 2 din se loose motions ho rahe hain, kal dikhana hai", ctx: NOPROF, expect: { intent: "BOOK", date: "2026-10-10", relation: "DAUGHTER", hasNonBookingContent: true, possibleEmergency: false } },
  { id: "h07", cat: "medical", text: "is dolo 650 safe in pregnancy?", expect: { intent: "OTHER", hasNonBookingContent: true } },
  { id: "h08", cat: "medical", text: "Mummy ke ghutne mein dard hai, Monday ko dikhana hai", expect: { intent: "BOOK", date: "2026-10-12", profileRef: "P2", hasNonBookingContent: true } },
  { id: "h09", cat: "medical", text: "thyroid report aayi hai TSH 8.2, doctor ko dikhani hai", expect: { visitType: "REPORT_SHOW", hasNonBookingContent: true } },
  { id: "h10", cat: "medical", text: "skin pe rashes aur khujli, appointment please tomorrow 6", expect: { intent: "BOOK", date: "2026-10-10", time: "18:00", hasNonBookingContent: true } },
  { id: "h11", cat: "medical", text: "I am feeling anxious and can't sleep, can I see the doctor monday", expect: { intent: "BOOK", date: "2026-10-12", hasNonBookingContent: true, possibleEmergency: false } },
  { id: "h12", cat: "medical", text: "periods late hain, checkup karwana hai", expect: { intent: "BOOK", hasNonBookingContent: true } },
  { id: "h13", cat: "medical", text: "my son has ear pain since morning, any slot today evening?", ctx: SON, expect: { intent: "BOOK", date: "2026-10-09", partOfDay: "evening", profileRef: "P3", hasNonBookingContent: true } },
  { id: "h14", cat: "medical", text: "after taking the tablets I feel dizzy", expect: { intent: "OTHER", hasNonBookingContent: true } },
  { id: "h15", cat: "medical", text: "पेट में दर्द है, कल सुबह आ सकते हैं?", expect: { intent: "BOOK", date: "2026-10-10", partOfDay: "morning", language: "hi", hasNonBookingContent: true } },
  { id: "h16", cat: "medical", text: "diabetes checkup and HbA1c discussion on saturday", expect: { intent: "BOOK", date: "2026-10-10", hasNonBookingContent: true } },
  { id: "h17", cat: "medical", text: "papa ki kidney ki problem hai, report dikhani hai", ctx: NOPROF, expect: { relation: "FATHER", visitType: "REPORT_SHOW", hasNonBookingContent: true } },
  { id: "h18", cat: "medical", text: "hair fall bahut ho raha hai", expect: { hasNonBookingContent: true, possibleEmergency: false } },

  // ── Emergencies (must be flagged) ────────────────────────────────
  { id: "e01", cat: "emergency", text: "papa ko chest pain ho raha hai abhi", expect: { possibleEmergency: true, hasNonBookingContent: true } },
  { id: "e02", cat: "emergency", text: "saans lene mein dikkat ho rahi hai", expect: { possibleEmergency: true } },
  { id: "e03", cat: "emergency", text: "my mother fainted and is not responding", expect: { possibleEmergency: true } },
  { id: "e04", cat: "emergency", text: "accident ho gaya hai, bahut khoon nikal raha hai", expect: { possibleEmergency: true } },
  { id: "e05", cat: "emergency", text: "my child swallowed something, he is choking", expect: { possibleEmergency: true } },
  { id: "e06", cat: "emergency", text: "बच्चे को दौरा पड़ा है", expect: { possibleEmergency: true, language: "hi" } },
  { id: "e07", cat: "emergency", text: "I don't want to live anymore", expect: { possibleEmergency: true } },
  { id: "e08", cat: "emergency", text: "face drooping on one side and can't speak properly", expect: { possibleEmergency: true } },
  { id: "e09", cat: "emergency", text: "severe chest pain and sweating, can I get the earliest slot", expect: { possibleEmergency: true } },
  { id: "e10", cat: "emergency", text: "baby has very high fever and fits", expect: { possibleEmergency: true } },

  // ── Controls: no health content, no emergency (precision) ────────
  { id: "c01", cat: "control", text: "I can come after office, around 7", expect: { time: "19:00", hasNonBookingContent: false, possibleEmergency: false } },
  { id: "c02", cat: "control", text: "please book the earliest slot tomorrow", expect: { intent: "BOOK", date: "2026-10-10", hasNonBookingContent: false, possibleEmergency: false } },
  { id: "c03", cat: "control", text: "my car broke down, will reach in 20 minutes", expect: { hasNonBookingContent: false, possibleEmergency: false } },
  { id: "c04", cat: "control", text: "Is parking available near the clinic?", expect: { intent: ["CLINIC_INFO", "OTHER"], hasNonBookingContent: false, possibleEmergency: false } },
  { id: "c05", cat: "control", text: "Thanks doctor, see you on Monday", expect: { intent: "THANKS", hasNonBookingContent: false, possibleEmergency: false } },
  { id: "c06", cat: "control", text: "kal ka appointment confirm hai na?", expect: { intent: ["MY_APPOINTMENTS", "AFFIRM", "OTHER"], hasNonBookingContent: false, possibleEmergency: false } },
  { id: "c07", cat: "control", text: "ok fine book 10:20", ctx: S("BK_PICK_SLOT", "choose a time", ["10:20", "11:00"]), expect: { intent: ["AFFIRM", "PROVIDE"], time: "10:20", hasNonBookingContent: false } },
  { id: "c08", cat: "control", text: "can my husband come instead of me", expect: { hasNonBookingContent: false, possibleEmergency: false } },

  // ── Hindi (Devanagari) ───────────────────────────────────────────
  { id: "d01", cat: "hindi", text: "मुझे कल सुबह दिखाना है", expect: { intent: "BOOK", date: "2026-10-10", partOfDay: "morning", forWhom: "self", language: "hi" } },
  { id: "d02", cat: "hindi", text: "मेरा नंबर कब आएगा", expect: { intent: "STATUS", language: "hi" } },
  { id: "d03", cat: "hindi", text: "अपॉइंटमेंट कैंसल कर दीजिए", expect: { intent: "CANCEL", language: "hi" } },
  { id: "d04", cat: "hindi", text: "सोमवार शाम 6 बजे माँ के लिए", expect: { intent: "BOOK", date: "2026-10-12", time: "18:00", profileRef: "P2", language: "hi" } },
  { id: "d05", cat: "hindi", text: "मैं क्लिनिक पहुँच गया हूँ", expect: { intent: "ARRIVED", language: "hi" } },
  { id: "d06", cat: "hindi", text: "धन्यवाद", expect: { intent: "THANKS", language: "hi" } },
  { id: "d07", cat: "hindi", text: "डॉक्टर साहब की फीस कितनी है", expect: { intent: "CLINIC_INFO", clinicInfoTopic: "fees", language: "hi" } },
  { id: "d08", cat: "hindi", text: "परसों दोपहर 12 बजे", ctx: S("BK_WHEN", "day and time"), expect: { intent: "PROVIDE", date: "2026-10-11", time: "12:00", language: "hi" } },

  // ── Noisy: typos, voice-transcript errors, multi-intent ──────────
  { id: "n01", cat: "noisy", text: "kal sham che baje appoinment", expect: { intent: "BOOK", date: "2026-10-10", time: "18:00" } },
  { id: "n02", cat: "noisy", text: "tmrw evng 7 pls", expect: { intent: ["BOOK", "PROVIDE"], date: "2026-10-10", time: "19:00" } },
  { id: "n03", cat: "noisy", text: "apointment chaiye monday ko subha", expect: { intent: "BOOK", date: "2026-10-12", partOfDay: "morning" } },
  { id: "n04", cat: "noisy", text: "hello hello doctor sahab appointment milega kya kal ka shaam ko paanch baje", expect: { intent: "BOOK", date: "2026-10-10", time: "17:00" } },
  { id: "n05", cat: "noisy", text: "cancel tomorrow and book monday instead", expect: { intent: ["RESCHEDULE", "CANCEL", "BOOK"], date: "2026-10-12" } },
  { id: "n06", cat: "noisy", text: "Sir I want appointment for my mother Sunita ji age 62 on Saturday", ctx: NOPROF, expect: { intent: "BOOK", date: "2026-10-10", relation: "MOTHER", newPersonName: "Sunita", hasNonBookingContent: false } },
  { id: "n07", cat: "noisy", text: "ok ok", ctx: S("BK_PICK_SLOT", "shall I book 6:30 PM?", ["18:30"]), expect: { intent: "AFFIRM" } },
  { id: "n08", cat: "noisy", text: "appointment 4 tomorrow morning ten thirty", expect: { intent: "BOOK", date: "2026-10-10", time: "10:30" } },
  { id: "n09", cat: "noisy", text: "Mam kal subah 10 bje ka time de do please mere liye", expect: { intent: "BOOK", date: "2026-10-10", time: "10:00", forWhom: "self" } },
  { id: "n10", cat: "noisy", text: "is 18.30 free on monday", expect: { intent: "BOOK", date: "2026-10-12", time: "18:30" } },
];
