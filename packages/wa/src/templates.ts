// Approved template registry (docs/WHATSAPP_INTEGRATION.md §5). Names must match Meta exactly.
// `params` lists the copy variables, in positional order {{1}}, {{2}}, …

export interface TemplateDef {
  name: string;
  category: "UTILITY" | "AUTHENTICATION";
  params: string[];
  quickReplies?: string[]; // payload prefixes, in button order (":<ref>" is appended when the send has a ref)
  /** Dynamic URL button: the copy variable whose value ends the button's URL (e.g. the pay-page token). */
  urlParam?: string;
}

export const TEMPLATES = {
  // Meta name differs from the key: the first wording was mis-categorised by Meta, so it was resubmitted under a new name.
  appointment_confirmed: { name: "booking_confirmation", category: "UTILITY", params: ["name", "dayShort", "time", "token", "addressShort"], quickReplies: ["appt:rs", "appt:cx"] },
  reminder_24h: { name: "reminder_24h", category: "UTILITY", params: ["name", "doctor", "dayShort", "time", "token"], quickReplies: ["appt:ok", "appt:rs", "appt:cx"] },
  reminder_same_day: { name: "reminder_same_day", category: "UTILITY", params: ["time", "name", "token", "runningStatus", "addressShort"], quickReplies: ["appt:late", "appt:cx"] },
  cancelled_by_clinic: { name: "cancelled_by_clinic", category: "UTILITY", params: ["name", "date", "time", "clinicPhone"], quickReplies: ["menu:book"] },
  doctor_running_late: { name: "doctor_running_late", category: "UTILITY", params: ["name", "min", "newTime"] },
  turn_near: { name: "turn_near", category: "UTILITY", params: ["name", "ahead", "eta"], quickReplies: ["menu:status"] },
  your_turn: { name: "your_turn", category: "UTILITY", params: ["name"] },
  walkin_token: { name: "walkin_token", category: "UTILITY", params: ["token", "name", "clinicName", "ahead", "eta"], quickReplies: ["menu:status"] },
  followup_due: { name: "followup_due", category: "UTILITY", params: ["name", "doctor", "date"], quickReplies: ["fu"] },
  payment_due: { name: "payment_due", category: "UTILITY", params: ["name", "amount", "clinicName", "date"], urlParam: "payToken" },
  payment_received: { name: "payment_received", category: "UTILITY", params: ["name", "amount", "date"] },
  staff_walkin_overflow: { name: "staff_walkin_overflow", category: "UTILITY", params: ["session", "name", "maskedPhone"], quickReplies: ["ovf:yes", "ovf:no"] },
  daily_summary: { name: "daily_summary", category: "UTILITY", params: ["date", "booked", "walkins", "completed", "noShows", "avgWait"] },
  no_show_rebook: { name: "no_show_rebook", category: "UTILITY", params: ["name"], quickReplies: ["menu:book"] },
  staff_login_otp: { name: "staff_login_otp", category: "AUTHENTICATION", params: ["code"] },
} satisfies Record<string, TemplateDef>;

export type TemplateName = keyof typeof TEMPLATES;

/** Meta language codes per app language. Hinglish users get the English template. */
export function templateLang(lang: "en" | "hi" | "hinglish"): string {
  return lang === "hi" ? "hi" : "en";
}
