import { createHash, randomBytes } from "node:crypto";
import { decrypt, displayPhone, encrypt, normalizeIndianPhone, phoneHash, type PatientAccount, type VisitType, type Relation } from "@clinicq/db";
import { copy as C, safety, slots as S, time as T } from "@clinicq/core";
import { CALL_SELF_RE, END_RE, extract, WRONG_RE, type Extraction, type ExtractContext } from "@clinicq/core/extract/index";
import { sttUnavailable } from "@clinicq/ai/stt";
import type { Button, InboundMessage, ListSection, OutMsg } from "@clinicq/wa";
import type { Ctx } from "../context";
import { activeCountForProfile, cancelAppointment, confirmHold, FamilySlotError, holdSlot, releaseHold, reschedule, SlotTakenError, upcomingForAccount, type UpcomingView } from "./booking";
import { clinicInfo, mapsLine, nowLocal, sessionHours, sessionsText, slotInstant, windowAvailability, type ClinicInfo } from "./clinic";
import { audit, sendTo } from "./notify";
import { createProfile, findOrCreateAccount, firstName, hasConsent, matchProfileByName, profileLabels, profilesOf, recordConsent, RELATION_LABEL, waName, type ProfileView } from "./patients";
import { arriveAppointment, notifyIfNext, positionOf } from "./queue";
import { requestWalkin, setOverflowDeclinedHandler, validateWalkinCode, WALKIN_RE } from "./walkin";
import { handleStaffMessage } from "./staffCommands";

// Conversation engine (docs/CONVERSATION_GUIDE.md). Raw text lives only in this function's memory;
// the conversation state persists structured fields only (DATA_POLICY §3).

type Lang = C.Lang;
type State =
  | "IDLE" | "AWAIT_CONSENT" | "AWAIT_NUMBER_CONFIRM" | "AWAIT_ALT_NUMBER"
  | "BK_WHO" | "BK_NAME" | "BK_WHEN" | "BK_PICK_SLOT" | "BK_FLOW_OPEN" | "BK_VISIT_TYPE" | "BK_CONFIRM" | "BK_RACE_DECLINED" | "BK_SAME_FAMILY"
  | "RS_PICK_APPT" | "CX_PICK_APPT" | "CX_CONFIRM" | "ERASE_CONFIRM" | "WALKIN_ASK_NAME" | "WI_AWAIT_STAFF";

interface SlotRef { date: string; startMin: number }
interface Pending {
  intent?: "BOOK" | "RESCHEDULE" | "WALKIN";
  profileId?: string;
  forWhom?: Extraction["forWhom"];
  relation?: Relation;
  newName?: string;
  forSelf?: boolean;
  visitType?: VisitType;
  rescheduleId?: string;
  date?: string;
  time?: number | null;
  tq?: Extraction["timeQualifier"];
  pod?: Extraction["partOfDay"];
  altPhone?: string;
  whoAsked?: boolean;
}
interface Conv {
  state: State;
  lang: Lang;
  langLock?: boolean;
  p: Pending;
  offered?: SlotRef[];
  requested?: { date?: string; time?: number | null; pod?: Extraction["partOfDay"] };
  held?: string;
  raceLost?: boolean;
  cxApptId?: string;
  cxIds?: string[]; // several appointments chosen for cancelling together
  cxList?: string[]; // the appointments shown in the cancel list, in their numbered order
  welcomeSent?: boolean;
  emergencyAt?: number;
  lastOut?: string; // kind of the bot's last message (context for short replies like "sure", "ok")
  pickerFailedAt?: number; // the booking page / form couldn't be delivered to this patient: use the list for a while
  notice?: "expired"; // the last conversation was left unfinished for over 30 minutes and was reset
  misses?: number; // typed messages in a row that didn't answer the pending question
  vary?: Record<string, number>; // per message: how often it was sent, so apologies etc. rotate their wording
  lastHash?: string; // short hash of the bot's last question (never patient text), to avoid asking it twice word for word
  seed: number;
}

/** Phrases are matched in memory only (like emergency keywords) and never stored. */
/** "privacy", "complaint", "grievance", "shikayat": who to contact (the privacy policy points patients here). */
const GRIEVANCE_RE = /\b(privacy|privacy policy|grievance|grievance officer|data protection)\b|गोपनीयता|प्राइवेसी|शिकायत अधिकारी/i;
const COMPLAINT_RE = /\b(complaint|complain|complaints|shikayat|shikaayat|shikayat)\b|शिकायत/i;
const ABANDON_RE = /\b(don'?t|do not|dont)\s+(want|need)\b|\bno need\b|\bnot now\b|\bleave it\b|\bforget it\b|\bnahi?n?\s+(chahiye|karna|karni)\b|\brehne\s+do\b|\bchh?o+d\s*do\b|\bmat\s+karo\b|नहीं\s+चाहिए|रहने\s+दो|छोड़\s+दो|मत\s+करो/i;
const RESTART_RE = /^\s*(start\s+(over|again|fresh)|restart|reset|new\s+chat|shuru\s+se|phir\s+se\s+shuru|फिर\s+से\s+शुरू|शुरू\s+से)\b/i;
/** Buttons from a conversation that has since been reset; they no longer carry enough context to continue. */
const STALE_BUTTON = /^(slot|vt|bk|see_all|sess|who|resume|rsday)(:|$)/;

/** "English please", "hindi mein baat karo", "switch to Hinglish" → the language asked for (null if none named). */
function languageTarget(text: string): Lang | null {
  const s = text.toLowerCase();
  if (/hinglish/.test(s)) return "hinglish";
  if (/\b(english|angrezi|angreji)\b|अंग्रेज़ी|अंग्रेजी|इंग्लिश/.test(s)) return "en";
  if (/\bhindi\b|हिंदी|हिन्दी/.test(s)) return "hi";
  return null;
}

/** After these the conversation is complete; a bare "ok / sure / thanks" deserves a polite close, not a menu. */
const CLOSING = new Set(["CLINIC_CONTACT", "CHAT_CLOSED", "BOOKING_STOPPED", "CLOSED_NO_CONSENT", "WRONG_NUMBER", "GRIEVANCE_INFO", "BOOKING_CONFIRMED", "CX_DONE", "CX_KEPT", "ERASE_KEPT", "CX_DONE_MANY", "CX_KEPT_MANY", "CX_REST_KEPT", "RS_DONE", "REMINDER_CONFIRMED", "STATUS", "STATUS_BOOKED", "STATUS_NEXT", "STATUS_FUTURE",
  "THANKS_REPLY", "ACK_CLOSING", "MY_DATA", "MY_APPOINTMENTS", "CLINIC_ADDRESS", "CLINIC_FEES", "CLINIC_TIMINGS", "ALT_NUMBER_SAVED", "ARRIVED_OK", "ALREADY_IN_QUEUE",
  "LANGUAGE_SET", "OPTED_IN", "OPTED_OUT", "CALL_CLINIC", "YOUR_TURN"]);

/** Messages that wait for an answer: these are never repeated word for word in reply to typed text. */
const PROMPTS = new Set(["WELCOME_CONSENT", "CONSENT_REMINDER", "CONFIRM_NUMBER", "ASK_ALT_NUMBER", "ALT_NUMBER_INVALID", "ASK_WHO", "ASK_NAME_SELF", "ASK_NAME_OTHER",
  "ASK_WHEN", "RS_ASK_WHEN", "ASK_WHEN_RETRY", "ASK_VISIT_TYPE", "CONFIRM_BOOKING_ASK", "RS_CONFIRM_ASK", "OFFER_NEAR_SLOTS", "SLOT_TAKEN_TYPED", "LIST_PICKER",
  "LIST_PICK_SESSION", "BOOK_LINK", "FLOW_BOOKING", "SAME_SLOT_FAMILY", "SLOT_RACE_DECLINED", "SLOT_RACE_LOST", "WALKIN_ASK_NAME", "WALKIN_CHECKING", "CX_CONFIRM",
  "ERASE_CONFIRM", "RS_PICK_APPT", "CX_PICK_APPT", "CX_CONFIRM_MANY", "CX_DONE_MORE", "OTHER_TIMES_OR_STOP", "RESUME_PROMPT", "WELCOME_BACK_MIDFLOW", "STUCK_HELP", "LANGUAGE_PICK"]);

const QUESTION: Partial<Record<State, string>> = {
  AWAIT_CONSENT: "agree to the privacy notice?", AWAIT_NUMBER_CONFIRM: "use this number for booking?", AWAIT_ALT_NUMBER: "10-digit mobile number",
  BK_WHO: "for you or someone else", BK_NAME: "the patient's name", BK_WHEN: "day and time", BK_PICK_SLOT: "choose a time",
  BK_VISIT_TYPE: "new consultation or follow-up", CX_CONFIRM: "cancel the appointment?", ERASE_CONFIRM: "delete your data?",
  WALKIN_ASK_NAME: "patient's name", BK_SAME_FAMILY: "book the next slot?", BK_RACE_DECLINED: "try another day or call the clinic?",
};

// ── turn helper ────────────────────────────────────────────────

const bodyHash = (s: string) => createHash("sha256").update(s).digest("base64url").slice(0, 12);

class Turn {
  /** Put in front of the next message (e.g. "Sorry, I didn't get that."), so an apology and the question arrive together. */
  lead?: string;
  /** This turn answers a typed or spoken message (not a button tap). */
  typed = false;
  /** The message said "all / both / saare / dono", or "no / nahi" (matched in memory only). */
  allWord = false;
  negated = false;
  private sent = 0;
  constructor(public ctx: Ctx, public info: ClinicInfo, public acc: PatientAccount, public waId: string, public conv: Conv, public profiles: ProfileView[]) {}
  get lang(): Lang { return this.conv.lang; }
  t(id: C.CopyId, vars: C.Vars = {}): string { return C.render(id, this.lang, { ...this.baseVars(), ...vars }, this.conv.seed); }
  /** Like t(), but the next wording each time (for replies that may be needed several times in a row). */
  tv(id: C.CopyId, vars: C.Vars = {}): string {
    const v = (this.conv.vary ??= {});
    const n = v[id] ?? 0;
    v[id] = n + 1;
    return C.render(id, this.lang, { ...this.baseVars(), ...vars }, n); // 1st wording, then the 2nd, then back
  }
  /** t(), but never the exact text of the bot's previous message (picks another wording when there is one). */
  fresh(id: C.CopyId, vars: C.Vars = {}): string {
    for (let k = 0; k < 4; k++) { const b = C.render(id, this.lang, { ...this.baseVars(), ...vars }, this.conv.seed + k); if (bodyHash(b) !== this.conv.lastHash) return b; }
    return this.t(id, vars);
  }
  b(id: C.BtnId, vars: C.Vars = {}): string { return C.btn(id, this.lang, vars); }
  baseVars(): C.Vars {
    const c = this.info.clinic;
    // The privacy policy link patients see: the clinic's own if it set a public one, else ClinicQ's (never a localhost address).
    const ownNotice = c.noticeUrl && /^https:\/\//.test(c.noticeUrl) && !/localhost|127\.0\.0\.1/.test(c.noticeUrl) ? c.noticeUrl : null;
    const noticeUrl = ownNotice ?? `${this.ctx.env.PUBLIC_BASE_URL}${this.ctx.env.BASE_PATH}/privacy`;
    return { clinicName: c.name, clinicPhone: c.phone, noticeUrl, grievanceEmail: this.ctx.env.GRIEVANCE_EMAIL, grievanceOfficer: this.ctx.env.GRIEVANCE_OFFICER, addressShort: c.addressShort, address: c.addressFull, mapsLine: mapsLine(this.info), sessionHours: sessionHours(this.info), sessionsText: sessionsText(this.info), doctor: this.info.doctor.displayName };
  }
  nameJi(name?: string | null): string {
    if (!name) return "";
    return this.lang === "hi" ? `, ${name} जी` : `, ${name} ji`;
  }
  async send(msg: OutMsg, kind: string): Promise<boolean> {
    if ("body" in msg && typeof msg.body === "string") {
      const hash = bodyHash(msg.body);
      // Typed text that didn't answer the question must never get the same question back word for word.
      if (this.typed && this.sent === 0 && !this.lead && PROMPTS.has(kind) && kind === this.conv.lastOut && hash === this.conv.lastHash) this.lead = this.tv("NOT_UNDERSTOOD", { nameJi: "" });
      if (this.lead) { msg = { ...msg, body: `${this.lead}\n\n${msg.body}` }; this.lead = undefined; }
      this.conv.lastHash = hash;
    }
    this.sent++;
    this.conv.lastOut = kind;
    return sendTo(this.ctx, this.waId, msg, { kind, accountId: this.acc.id });
  }
  async text(id: C.CopyId, vars: C.Vars = {}): Promise<void> { await this.send({ kind: "text", body: this.t(id, vars) }, id); }
  async buttons(body: string, kind: string, buttons: Button[]): Promise<void> {
    if (!buttons.length) { await this.send({ kind: "text", body }, kind); return; }
    await this.send({ kind: "buttons", body, buttons: buttons.slice(0, 3) }, kind);
  }
  set(state: State): void { this.conv.state = state; }
}

// ── persistence ────────────────────────────────────────────────

async function loadConv(ctx: Ctx, acc: PatientAccount): Promise<Conv> {
  const row = await ctx.db.conversationState.findUnique({ where: { accountId: acc.id } });
  const fresh: Conv = { state: "IDLE", lang: acc.language, p: {}, seed: Math.floor(Math.random() * 1000) };
  if (!row) return fresh;
  const c = row.context as unknown as Conv;
  if (row.expiresAt < ctx.clock.now()) {
    // Left unfinished for over 30 minutes: start from the beginning, and tell the patient (if they were mid-way).
    const midway = !["IDLE", "AWAIT_CONSENT", "AWAIT_NUMBER_CONFIRM"].includes(row.state);
    return { ...fresh, lang: c.lang ?? acc.language, langLock: c.langLock, welcomeSent: c.welcomeSent, notice: midway ? "expired" : undefined };
  }
  return { ...fresh, ...c, state: row.state as State };
}

async function saveConv(ctx: Ctx, accountId: string, conv: Conv): Promise<void> {
  const { state, ...rest } = conv;
  const expiresAt = new Date(ctx.clock.now().getTime() + 30 * 60_000);
  await ctx.db.conversationState.upsert({ where: { accountId }, create: { accountId, state, context: rest as never, expiresAt }, update: { state, context: rest as never, expiresAt } });
}

// ── entry point ────────────────────────────────────────────────

export async function handleInbound(ctx: Ctx, msg: InboundMessage): Promise<void> {
  const info = await clinicInfo(ctx);
  const staff = await ctx.db.staffUser.findUnique({ where: { phoneHash: phoneHash(msg.from) } });
  if (staff?.active && (await handleStaffMessage(ctx, staff, msg))) return;

  const acc = await findOrCreateAccount(ctx, msg.from, msg.profileName);
  await ctx.db.messageLog.create({ data: { accountId: acc.id, direction: "IN", kind: `in:${msg.kind}${msg.isVoice ? ":voice" : ""}`, wamid: msg.wamid } }).catch(() => undefined);
  const conv = await loadConv(ctx, acc);
  const t = new Turn(ctx, info, acc, msg.from, conv, await profilesOf(ctx, acc.id));
  try {
    const expired = t.conv.notice === "expired";
    t.conv.notice = undefined;
    if (expired) await t.text("SESSION_RESTARTED");
    if (expired && msg.kind === "button" && STALE_BUTTON.test(msg.buttonId ?? "")) await menu(t, "MAIN_MENU");
    else await route(t, msg);
  } catch (e) {
    if (e instanceof ErasedSignal) return; // account deleted on request — persist nothing
    ctx.log.error({ err: e }, "conversation_error");
    await t.text("SYSTEM_ERROR").catch(() => undefined);
  }
  if (!(await ctx.db.patientAccount.findUnique({ where: { id: acc.id }, select: { id: true } }))) return; // erased meanwhile
  await saveConv(ctx, acc.id, t.conv);
  if (t.conv.lang !== acc.language) await ctx.db.patientAccount.update({ where: { id: acc.id }, data: { language: t.conv.lang } });
}

async function route(t: Turn, msg: InboundMessage): Promise<void> {
  if (msg.kind === "reaction") return;
  if (msg.kind === "media") {
    await t.text(msg.mediaType === "sticker" ? "OTHER_HELP" : "MEDIA_REPORTS");
    return resumePrompt(t);
  }
  if (msg.kind === "location") return t.text("CLINIC_ADDRESS");
  if (msg.kind === "unsupported") return menu(t, "OTHER_HELP");
  if (msg.kind === "flow") return onFlowCompleted(t, msg.flowResponse ?? {});
  if (msg.kind === "button" && msg.buttonId) return onButton(t, msg.buttonId);

  let text = msg.text ?? "";
  let isVoice = false;
  if (msg.kind === "audio") {
    const tr = await transcribeVoice(t, msg.mediaId);
    if (tr.kind !== "ok") {
      // Say what happened, then show the pending question or the options again so the patient can tap or type.
      await t.text(tr.kind === "too_long" ? "VOICE_TOO_LONG" : tr.kind === "unavailable" ? "VOICE_UNAVAILABLE" : "VOICE_UNCLEAR");
      return reprompt(t);
    }
    text = tr.text;
    isVoice = true;
  }
  if (!text.trim()) return menu(t, "OTHER_HELP");
  t.typed = true;
  await onText(t, text, isVoice);
}

type VoiceResult = { kind: "ok"; text: string } | { kind: "unclear" } | { kind: "unavailable" } | { kind: "too_long" };

/** Speech-to-text services that failed for a reason retrying won't fix (no quota, no subscription…): skipped for a while. */
const sttDownUntil = new Map<string, number>();
const STT_DOWN_MS = 10 * 60_000;

async function transcribeVoice(t: Turn, mediaId?: string): Promise<VoiceResult> {
  if (!mediaId) return { kind: "unclear" };
  let audio: Buffer | null = null;
  try {
    const m = await t.ctx.wa.downloadMedia(mediaId, 5 * 1024 * 1024);
    audio = m.data;
    const now = t.ctx.clock.now().getTime();
    let heard = false; // some service listened (even if it caught nothing useful)
    for (const stt of await t.ctx.stt()) {
      if ((sttDownUntil.get(stt.name) ?? 0) > now) continue;
      try {
        const r = await stt.transcribe(audio, m.mime, 8000);
        sttDownUntil.delete(stt.name);
        heard = true;
        if (r.text.split(/\s+/).filter(Boolean).length >= 2 && (r.confidence == null || r.confidence >= 0.6)) return { kind: "ok", text: r.text };
      } catch (e) {
        const down = sttUnavailable(e);
        if (down) sttDownUntil.set(stt.name, now + STT_DOWN_MS);
        t.ctx.log.warn({ err: e, stt: stt.name, down }, "stt_failed");
      }
    }
    if (!heard) t.ctx.log.warn({}, "stt_unavailable"); // every speech service is down: alert on this log line
    return { kind: heard ? "unclear" : "unavailable" };
  } catch (e) {
    return (e as { status?: number }).status === 413 ? { kind: "too_long" } : { kind: "unclear" };
  } finally {
    audio = null; // drop the only reference — audio is never persisted
  }
}

// ── text handling ──────────────────────────────────────────────

function extractCtx(t: Turn): ExtractContext {
  const n = nowLocal(t.ctx);
  return {
    today: n.date, nowTime: n.time,
    sessions: t.info.sessions.map((s) => ({ weekday: s.weekday, label: s.label, start: s.startTime, end: s.endTime })),
    profiles: profileLabels(t.profiles),
    state: t.conv.state, question: QUESTION[t.conv.state],
    offeredTimes: t.conv.offered?.map((o) => T.fromMin(o.startMin)),
  };
}

async function onText(t: Turn, text: string, isVoice: boolean): Promise<void> {
  if (WALKIN_RE.test(text)) {
    if (!(await validateWalkinCode(t.ctx, text))) return t.text("WALKIN_BAD_CODE");
    t.conv.p = { intent: "WALKIN" };
    if (!(await gates(t, null))) return;
    return walkinAsk(t);
  }
  const emergencyKw = safety.matchesEmergency(text, t.info.settings.emergencyKeywordsExtra);
  if (emergencyKw) return emergency(t);
  if (RESTART_RE.test(text) && t.conv.state !== "AWAIT_CONSENT") return stopFlow(t, "STARTED_OVER");
  // Privacy questions and complaints get the grievance contact, before anything else (no consent needed to ask).
  if ((GRIEVANCE_RE.test(text) || (COMPLAINT_RE.test(text) && text.trim().split(/\s+/).length <= 8)) && !/\b(delete|erase|remove|hatao|mita)\b/i.test(text)) {
    if (!t.conv.langLock) t.conv.lang = /[ऀ-ॿ]/.test(text) ? "hi" : /\b(shikayat|shikaayat|karni|hai|kaise|kahan|kisse)\b/i.test(text) ? "hinglish" : t.conv.lang;
    await t.text("GRIEVANCE_INFO");
    return t.conv.state.startsWith("BK_") || t.conv.state.startsWith("CX_") || t.conv.state.startsWith("RS_") ? reprompt(t) : undefined;
  }
  // "all / both / saare / dono": every upcoming appointment (for cancelling), whatever else the message says.
  t.negated = /\b(no|nahi|nahin|na|mat|don'?t|not|keep)\b|नहीं|मत/i.test(text);
  t.allWord = /\b(all|both|saare|sare|saari|sab|sabhi|dono|donon)\b|सब|सभी|सारे|दोनों/i.test(text);
  // Choosing what to cancel: "2", "1 and 3", "all", "dono" pick from the numbered list.
  if (t.conv.state === "CX_PICK_APPT" && t.conv.cxList?.length) {
    const picked = pickFromList(text, t.conv.cxList);
    if (picked) { text = ""; return picked.length === 1 ? askCancelConfirm(t, picked[0]!) : askCancelMany(t, picked); }
  }
  const abandon = ABANDON_RE.test(text);
  const ending: Ending = { end: END_RE.test(text), wrong: WRONG_RE.test(text), callSelf: CALL_SELF_RE.test(text) };
  const langTarget = languageTarget(text);
  // "English please", "hindi mein baat karo", "Hinglish" on its own: a language request even if the model says otherwise.
  const langRequest = !!langTarget && (/\b(language|bhasha|baat|talk|speak|switch|reply|please|pls|mein|me)\b|भाषा|में/i.test(text) || text.trim().split(/\s+/).length <= 2);

  const out = await extract(text, extractCtx(t), await t.ctx.cascade());
  const meta = { intent: out.extraction.intent, source: out.source, escalated: out.escalated, reasons: out.reasons, calls: out.calls.map((c) => ({ spec: c.spec, ok: c.ok, ms: c.latencyMs, err: c.error })) };
  // Every configured model failed → we're running on the rules fallback; alert on this log line.
  if (out.source === "rules" && out.calls.length && out.calls.every((c) => !c.ok)) t.ctx.log.warn(meta, "ai_models_unavailable");
  else t.ctx.log.info(meta, "extracted");
  const e = out.extraction;
  if (e.possibleEmergency) return emergency(t);
  if (!t.conv.langLock) t.conv.lang = e.language;
  text = ""; // raw text is not needed beyond this point

  // Not wanting to go on ("don't want to book", "no thanks", "bye", "close the chat", "wrong number", "nahi chahiye",
  // "I'll call the clinic"): answered for what it is, with no menu and no next question.
  if (await wantsToEnd(t, e, ending)) return endChat(t, ending);

  // Courtesy and control messages ("hold on", "stupid", "what can you do?", "stop") get a proper answer first,
  // whatever question is pending, so the patient never just gets the same question again.
  if (await courtesy(t, e)) return;
  if (!(await gates(t, e))) return;

  const bookingish = ["BOOK", "PROVIDE", "RESCHEDULE", "AFFIRM", "DENY"].includes(e.intent) || t.conv.state.startsWith("BK_");
  if (e.hasNonBookingContent) {
    if (isVoice) await t.text("VOICE_UNDERSTOOD", { nameJi: t.nameJi(senderName(t)), when: whenLabel(t, e) });
    await t.send({ kind: "text", body: (isVoice ? t.t("HEALTH_NOT_SAVED") : t.t("HEALTH_DETAILS_REDIRECT", { nameJi: t.nameJi(senderName(t)) })) }, "HEALTH_DETAILS_REDIRECT");
    if (!bookingish && e.intent === "OTHER") return t.conv.state === "IDLE" ? menu(t, "OTHER_HELP") : resumePrompt(t);
  } else if (isVoice && ["BOOK", "PROVIDE"].includes(e.intent) && (e.date || e.time || e.partOfDay)) {
    await t.text("VOICE_UNDERSTOOD", { nameJi: t.nameJi(senderName(t)), when: whenLabel(t, e) });
  }

  if (langRequest && langTarget && !e.date && e.time == null && !e.partOfDay) return setLanguage(t, langTarget);

  // Mid-way through a booking, understand what the patient wants now instead of repeating the last question.
  const inBooking = t.conv.state.startsWith("BK_");
  if (inBooking && (abandon || (e.intent === "CANCEL" && !e.date)) && !e.date && e.time == null && !e.partOfDay && !e.visitType) return stopBooking(t);
  if (inBooking && e.intent === "GREETING") return welcomeBack(t);
  if (t.conv.state !== "IDLE" && e.intent === "GREETING") return stopFlow(t, "MAIN_MENU"); // e.g. "hi" instead of confirming a cancellation
  if (inBooking && e.intent === "BOOK" && !e.date && e.time == null && !e.partOfDay && !["BK_WHO", "BK_NAME"].includes(t.conv.state)) return newBooking(t, e);

  // Global intents work from any state.
  switch (e.intent) {
    case "STATUS": return status(t);
    case "ARRIVED": return arrived(t);
    case "MY_APPOINTMENTS": return myAppointments(t);
    case "CLINIC_INFO": return clinicInfoReply(t, e.clinicInfoTopic);
    case "TALK_TO_STAFF": return talkToStaff(t);
    case "MY_DATA": return myData(t);
    case "DELETE_DATA": t.set("ERASE_CONFIRM"); return t.buttons(t.t("ERASE_CONFIRM"), "ERASE_CONFIRM", [{ id: "erase:yes", title: t.b("YES_DELETE") }, { id: "erase:no", title: t.b("KEEP_IT") }]);
    case "STOP": return optOut(t);
    case "START": await t.ctx.db.patientAccount.update({ where: { id: t.acc.id }, data: { optedOutAt: null } }); return t.text("OPTED_IN");
    case "CHANGE_LANGUAGE": return langTarget ? setLanguage(t, langTarget) : askLanguage(t);
    case "CHANGE_NUMBER": t.set("AWAIT_ALT_NUMBER"); return t.text("CHANGE_NUMBER_INFO");
    case "THANKS": if (t.conv.state === "IDLE" || !t.conv.state.startsWith("BK_")) return t.text("THANKS_REPLY"); break;
    case "CANCEL":
      if (t.allWord) return cancelAll(t); // "cancel all my appointments", "dono cancel kar do"
      if (t.conv.state !== "CX_CONFIRM" && t.conv.state !== "CX_PICK_APPT") return startCancel(t, e);
      break;
    case "RESCHEDULE": return startReschedule(t, e);
    default: break;
  }
  if (t.conv.state === "CX_CONFIRM" && t.allWord && !t.negated) {
    if (t.conv.cxIds?.length) return doCancelMany(t); // "dono" / "all of them" to "cancel these 2?" is a yes
    return cancelAll(t); // "both" when only one was offered
  }
  // Mid-way through something, a message that answers nothing: say so, and ask again (with a way out after two tries).
  if (t.conv.state !== "IDLE" && e.intent === "OTHER" && !e.hasNonBookingContent && !answersSomething(e)) return notUnderstood(t);
  t.conv.misses = 0;
  return onState(t, e);
}

/** Did the extraction find anything that could answer a question (a day, time, name, number, person or visit type)? */
function answersSomething(e: Extraction): boolean {
  return !!(e.date || e.time || e.partOfDay || e.phone || e.selfName || e.newPersonName || e.profileRef || e.relation || e.visitType || e.forWhom !== "unknown");
}

async function courtesy(t: Turn, e: Extraction): Promise<boolean> {
  if (e.intent === "STOP") { await optOut(t); return true; }
  if (!["WAIT", "RUDE", "HELP"].includes(e.intent)) return false;
  // A brand-new patient's first message gets the welcome (which already says what I can do).
  if (!t.conv.welcomeSent && !(await hasConsent(t.ctx, t.acc.id))) return false;
  const idle = t.conv.state === "IDLE";
  if (e.intent === "WAIT") { const id = idle ? "WAIT_OK_IDLE" : "WAIT_OK"; await t.send({ kind: "text", body: t.tv(id) }, id); return true; }
  const id = e.intent === "RUDE" ? "RUDE_REPLY" : "HELP_REPLY";
  if (idle && (await hasConsent(t.ctx, t.acc.id)) && t.acc.numberConfirmedAt) { await menu(t, id); return true; }
  t.lead = t.tv(id, { nameJi: t.nameJi(senderName(t)) });
  await reprompt(t);
  return true;
}

/** "Stop": no more reminders or updates, and whatever was in progress is dropped. */
async function optOut(t: Turn): Promise<void> {
  if (t.conv.held) { await releaseHold(t.ctx, t.conv.held); t.conv.held = undefined; }
  t.conv.p = {};
  t.conv.offered = undefined;
  t.conv.requested = undefined;
  t.set("IDLE");
  await t.ctx.db.patientAccount.update({ where: { id: t.acc.id }, data: { optedOutAt: t.ctx.clock.now() } });
  return t.text("OPTED_OUT");
}

async function notUnderstood(t: Turn): Promise<void> {
  t.conv.misses = (t.conv.misses ?? 0) + 1;
  const nameJi = t.nameJi(senderName(t));
  if (t.conv.misses >= 2) {
    t.conv.misses = 0;
    return t.buttons(t.t("STUCK_HELP", { nameJi }), "STUCK_HELP", [{ id: "resume:go", title: t.b("CONTINUE") }, { id: "resume:menu", title: t.b("MENU") }, { id: "call", title: t.b("CALL_CLINIC") }]);
  }
  // No day understood: that question has its own retry, with the free times or stopping one tap away.
  if (t.conv.state === "BK_WHEN" && t.conv.p.intent !== "RESCHEDULE") return t.buttons(t.t("ASK_WHEN_RETRY"), "ASK_WHEN_RETRY", [{ id: "see_all", title: t.b("SHOW_FREE_TIMES") }, { id: "bk:stop", title: t.b("STOP_BOOKING") }]);
  t.lead = t.tv("NOT_UNDERSTOOD", { nameJi });
  return reprompt(t);
}

/** Ask the pending question again (any state), e.g. after an apology or an answer to a side question. */
async function reprompt(t: Turn): Promise<void> {
  switch (t.conv.state) {
    case "IDLE": return menu(t, "OTHER_HELP");
    case "AWAIT_CONSENT": return t.buttons(t.t("CONSENT_REMINDER"), "CONSENT_REMINDER", [{ id: "consent:yes", title: t.b("AGREE") }]);
    case "AWAIT_NUMBER_CONFIRM": await askNumber(t); return;
    case "AWAIT_ALT_NUMBER": return t.text("ASK_ALT_NUMBER");
    case "BK_NAME": return t.text(t.conv.p.forSelf ? "ASK_NAME_SELF" : "ASK_NAME_OTHER");
    case "WALKIN_ASK_NAME": return walkinAsk(t);
    case "WI_AWAIT_STAFF": return t.text("WALKIN_CHECKING", { name: currentName(t) ?? "" });
    case "CX_CONFIRM": return t.conv.cxIds?.length ? askCancelMany(t, t.conv.cxIds) : t.conv.cxApptId ? askCancelConfirm(t, t.conv.cxApptId) : stopFlow(t, "MAIN_MENU");
    case "ERASE_CONFIRM": return t.buttons(t.t("ERASE_CONFIRM"), "ERASE_CONFIRM", [{ id: "erase:yes", title: t.b("YES_DELETE") }, { id: "erase:no", title: t.b("KEEP_IT") }]);
    case "RS_PICK_APPT": return startReschedule(t, null);
    case "CX_PICK_APPT": return startCancel(t, null);
    case "BK_RACE_DECLINED": return raceDeclined(t, t.conv.requested?.time);
    case "BK_SAME_FAMILY": case "BK_PICK_SLOT":
      if (t.conv.offered?.length) return t.buttons(t.t("OFFER_NEXT_AVAILABLE"), "OFFER_NEAR_SLOTS", [...t.conv.offered.slice(0, 2).map(slotBtn), { id: "see_all", title: t.b("SEE_ALL") }]);
      return askWhen(t);
    default: return resumePrompt(t);
  }
}

async function onState(t: Turn, e: Extraction): Promise<void> {
  const s = t.conv.state;
  switch (s) {
    case "AWAIT_ALT_NUMBER": return altNumber(t, e);
    // A bare "no" to who / name / visit type / when: the patient doesn't want to go on with the booking.
    case "BK_WHO": if (e.intent === "DENY" && !answersSomething(e)) return stopBooking(t); return answerWho(t, e);
    case "BK_NAME": if (e.intent === "DENY" && !answersSomething(e)) return stopBooking(t); return answerName(t, e);
    case "BK_WHEN": if (e.intent === "DENY" && !e.date && e.time == null) return stopBooking(t); return answerWhen(t, e);
    case "BK_PICK_SLOT": return answerPick(t, e);
    case "BK_FLOW_OPEN": // typed a day/time instead of using the booking page
      if (e.intent === "DENY" && !e.date && e.time == null) return stopBooking(t);
      return answerWhen(t, e);
    case "BK_VISIT_TYPE":
      if (e.visitType) { t.conv.p.visitType = e.visitType; return askConfirm(t); }
      if (e.intent === "DENY" && !answersSomething(e)) return stopBooking(t);
      if (e.date || e.time != null) return answerPick(t, e);
      return askVisitType(t);
    case "BK_CONFIRM":
      if (e.visitType) { t.conv.p.visitType = e.visitType; return askConfirm(t); }
      if (e.date || e.time != null) return answerPick(t, e);
      if (e.intent === "AFFIRM" || e.intent === "BOOK") return finalize(t);
      if (e.intent === "DENY") return otherTimesOrStop(t);
      return askConfirm(t);
    case "BK_RACE_DECLINED":
      if (e.date || e.time != null || e.partOfDay) { mergeWhen(t, e); return offer(t); }
      if (e.intent === "AFFIRM") return askWhen(t);
      return callClinic(t);
    case "BK_SAME_FAMILY":
      if (e.intent === "AFFIRM" && t.conv.offered?.[0]) return choose(t, t.conv.offered[0]);
      if (e.intent === "DENY") return askWhen(t);
      return answerPick(t, e);
    case "CX_CONFIRM":
      if (e.intent === "AFFIRM" && t.conv.cxIds?.length) return doCancelMany(t);
      if (e.intent === "AFFIRM" && t.conv.cxApptId) return doCancel(t, t.conv.cxApptId);
      if (e.intent === "DENY") { const many = !!t.conv.cxIds?.length; t.conv.cxIds = undefined; t.set("IDLE"); return t.text(many ? "CX_KEPT_MANY" : "CX_KEPT"); }
      return t.buttons(t.t("OTHER_HELP"), "CX_CONFIRM", cxButtons(t));
    case "ERASE_CONFIRM":
      if (e.intent === "AFFIRM") return erase(t);
      t.set("IDLE");
      await t.text("ERASE_KEPT"); // anything but a clear yes keeps the data
      if (e.intent === "DENY") return;
      return onState(t, e); // e.g. "book tomorrow" instead of answering
    case "WALKIN_ASK_NAME": return walkinName(t, e);
    case "WI_AWAIT_STAFF": return t.text("WALKIN_CHECKING", { name: currentName(t) ?? "" });
    case "RS_PICK_APPT": case "CX_PICK_APPT": return s === "RS_PICK_APPT" ? startReschedule(t, e) : startCancel(t, e);
    default: break;
  }
  // IDLE
  if (e.intent === "BOOK" || (e.intent === "PROVIDE" && (e.date || e.time != null || e.partOfDay))) return startBooking(t, e);
  if (e.intent === "GREETING") return menu(t, "MAIN_MENU");
  if (t.conv.lastOut && CLOSING.has(t.conv.lastOut) && (e.intent === "AFFIRM" || e.intent === "DENY")) return t.text("ACK_CLOSING");
  // "no" to "How can I help?": nothing needed. "ok" to it: a nudge, not the same menu again.
  if (e.intent === "DENY") return endChat(t, { end: true, wrong: false, callSelf: false });
  if (e.intent === "AFFIRM") return t.conv.lastOut && MENUS.has(t.conv.lastOut) ? t.text("MENU_NUDGE") : menu(t, "OTHER_HELP");
  if (e.hasNonBookingContent) return;
  return menu(t, "OFF_TOPIC");
}

// ── gates: consent → number confirmation ──────────────────────

async function gates(t: Turn, e: Extraction | null, buttonId?: string): Promise<boolean> {
  if (!(await hasConsent(t.ctx, t.acc.id))) {
    const agrees = buttonId === "consent:yes" || (t.conv.state === "AWAIT_CONSENT" && e && (e.intent === "AFFIRM"));
    if (buttonId === "consent:no") { t.set("IDLE"); await t.text("CONSENT_DECLINED"); return false; }
    if (!agrees) {
      if (e) rememberPending(t, e);
      t.set("AWAIT_CONSENT");
      if (!t.conv.welcomeSent) {
        t.conv.welcomeSent = true;
        await t.buttons(t.t("WELCOME_CONSENT"), "WELCOME_CONSENT", [{ id: "consent:yes", title: t.b("AGREE") }]);
      } else {
        if (e?.intent === "DENY") { t.set("IDLE"); await t.text("CONSENT_DECLINED"); return false; }
        if (e) await gateLead(t, e, "");
        await t.buttons(t.t("CONSENT_REMINDER"), "CONSENT_REMINDER", [{ id: "consent:yes", title: t.b("AGREE") }]);
      }
      return false;
    }
    t.conv.misses = 0;
    await recordConsent(t.ctx, t.acc.id, t.info.settings.noticeVersion, t.lang);
    await audit(t.ctx, "PATIENT", t.acc.id, "consent.given", "PatientAccount", t.acc.id, { noticeVersion: t.info.settings.noticeVersion });
    t.set("IDLE");
    if (!t.acc.numberConfirmedAt) return askNumber(t);
  }
  if (!t.acc.numberConfirmedAt) {
    if (t.conv.state === "AWAIT_ALT_NUMBER" && e) { await altNumber(t, e); return false; }
    const use = buttonId === "num:use" || (t.conv.state === "AWAIT_NUMBER_CONFIRM" && e?.intent === "AFFIRM");
    const alt = buttonId === "num:alt" || (t.conv.state === "AWAIT_NUMBER_CONFIRM" && (e?.intent === "DENY" || !!e?.phone));
    if (use) { await confirmNumber(t); return resumePending(t); }
    if (alt) {
      if (e?.phone) { await altNumber(t, e); return false; }
      t.set("AWAIT_ALT_NUMBER");
      await t.text("ASK_ALT_NUMBER");
      return false;
    }
    if (e) rememberPending(t, e);
    if (e && t.conv.state === "AWAIT_NUMBER_CONFIRM") await gateLead(t, e, t.t("NUMBER_WHY"));
    return askNumber(t);
  }
  return true;
}

/** Before asking a gate question again: answer what the patient said, or say why the question matters. */
async function gateLead(t: Turn, e: Extraction, why: string): Promise<void> {
  const nameJi = t.nameJi(senderName(t));
  if (e.intent === "CLINIC_INFO") { await clinicInfoReply(t, e.clinicInfoTopic); return; }
  if (e.intent === "GREETING") { t.lead = t.tv("HELLO_AGAIN", { nameJi }); return; }
  if (e.intent !== "OTHER") { if (why) t.lead = why; return; } // a real request: just say why the question comes first
  t.conv.misses = (t.conv.misses ?? 0) + 1;
  t.lead = [t.tv("NOT_UNDERSTOOD", { nameJi }), why, t.conv.misses >= 2 ? t.t("GATE_CALL_ALT") : ""].filter(Boolean).join(" ");
}

async function askNumber(t: Turn): Promise<false> {
  t.set("AWAIT_NUMBER_CONFIRM");
  const phone = displayPhone(t.waId);
  await t.buttons(t.t("CONFIRM_NUMBER", { nameJi: t.nameJi(waName(t.acc)), waPhone: phone }), "CONFIRM_NUMBER", [
    { id: "num:use", title: t.b("USE_NUMBER", { phone }) },
    { id: "num:alt", title: t.b("DIFFERENT_NUMBER") },
  ]);
  return false;
}

async function confirmNumber(t: Turn): Promise<void> {
  t.acc = await t.ctx.db.patientAccount.update({ where: { id: t.acc.id }, data: { numberConfirmedAt: t.ctx.clock.now() } });
  t.set("IDLE");
  t.conv.misses = 0;
}

async function altNumber(t: Turn, e: Extraction): Promise<void> {
  const norm = e.phone ? normalizeIndianPhone(e.phone) : null;
  if (!norm) { t.set("AWAIT_ALT_NUMBER"); return t.text("ALT_NUMBER_INVALID"); }
  t.conv.p.altPhone = norm;
  const self = t.profiles.find((p) => p.relation === "SELF");
  if (self) await t.ctx.db.patientProfile.update({ where: { id: self.id }, data: { contactPhone: encrypt(norm) } });
  await t.text("ALT_NUMBER_SAVED", { altPhone: displayPhone(norm) });
  const firstTime = !t.acc.numberConfirmedAt;
  await confirmNumber(t);
  if (firstTime) await resumePending(t);
}

function rememberPending(t: Turn, e: Extraction): void {
  if (["BOOK", "PROVIDE"].includes(e.intent) && (e.date || e.time || e.partOfDay || e.forWhom !== "unknown" || e.intent === "BOOK")) {
    t.conv.p = { ...t.conv.p, intent: t.conv.p.intent ?? "BOOK" };
    mergeWho(t, e);
    mergeWhen(t, e);
  }
}

async function resumePending(t: Turn): Promise<false> {
  const p = t.conv.p;
  if (p.intent === "WALKIN") await walkinAsk(t);
  else if (p.intent === "BOOK") await progressBooking(t);
  else await menu(t, "MAIN_MENU");
  return false;
}

// ── buttons ────────────────────────────────────────────────────

async function onButton(t: Turn, id: string): Promise<void> {
  const [kind, a, b] = id.split(":");
  if (kind === "consent" || kind === "num") { if (await gates(t, null, id)) await resumePending(t); return; }
  if (kind === "call") return callClinic(t);
  if (!(await gates(t, null))) return;
  // A booking button from a conversation that's no longer in progress: start from the menu instead of half a booking.
  if (t.conv.state === "IDLE" && !t.conv.p.intent && STALE_BUTTON.test(id)) return menu(t, "MAIN_MENU");
  switch (kind) {
    case "slot": {
      const [date, min] = (a ?? "").split("|");
      if (!date || !min) return askWhen(t);
      return choose(t, { date, startMin: Number(min) });
    }
    case "see_all": return slotPicker(t, t.conv.requested?.date ?? nowLocal(t.ctx).date);
    case "sess": { const [date, label] = (a ?? "").split("|"); return slotPicker(t, date ?? nowLocal(t.ctx).date, false, label); }
    case "vt": t.conv.p.visitType = a as VisitType; return askConfirm(t);
    case "bk": return a === "yes" ? finalize(t) : a === "stop" ? stopBooking(t) : changeTime(t);
    case "rsday": if (!a) return askWhen(t); t.conv.p.date = a; t.conv.p.time = null; t.conv.p.tq = null; t.conv.p.pod = undefined; return offer(t);
    case "lang": return a === "en" || a === "hi" || a === "hinglish" ? setLanguage(t, a) : askLanguage(t);
    case "resume":
      if (a === "go") return reprompt(t);
      if (a === "new") return newBooking(t, null);
      return stopFlow(t, "MAIN_MENU");
    case "who":
      if (a === "me") { t.conv.p.forWhom = "self"; t.conv.p.whoAsked = true; t.conv.p.profileId = undefined; return progressBooking(t); }
      if (a === "other") { t.conv.p.forWhom = "new_person"; t.set("BK_NAME"); return t.text("ASK_NAME_OTHER"); }
      t.conv.p.profileId = a; return progressBooking(t);
    case "wi":
      if (a === "other") { t.set("WALKIN_ASK_NAME"); return t.text("ASK_NAME_OTHER"); }
      return walkinIssue(t, a!);
    case "appt":
      if (a === "ok") return t.text("REMINDER_CONFIRMED");
      if (a === "late") return t.text("REMINDER_CONFIRMED");
      if (a === "rs" && b) return beginReschedule(t, b, null);
      if (a === "cx" && b) return startCancel(t, null, b); // shows all upcoming appointments when there are several
      return myAppointments(t);
    case "cx":
      if (a === "yes" && b) return doCancel(t, b);
      if (a === "many") return doCancelMany(t);
      if (a === "more") return startCancel(t, null);
      t.set("IDLE");
      if (a === "done") return t.text("CX_REST_KEPT");
      { const many = !!t.conv.cxIds?.length; t.conv.cxIds = undefined; return t.text(many ? "CX_KEPT_MANY" : "CX_KEPT"); }
    case "rs": return beginReschedule(t, a!, null);
    case "cxp": return a === "all" ? askCancelMany(t, t.conv.cxList ?? []) : askCancelConfirm(t, a!);
    case "erase": if (a === "yes") return erase(t); t.set("IDLE"); return t.text("ERASE_KEPT");
    case "race": return a === "another" ? askWhen(t) : callClinic(t);
    case "call": return callClinic(t);
    case "menu":
      if (a === "book") { t.conv.p = { intent: "BOOK", profileId: t.conv.p.profileId }; return progressBooking(t); }
      if (a === "status") return status(t);
      if (a === "appts") return myAppointments(t);
      if (a === "lang") return askLanguage(t);
      return menu(t, "MAIN_MENU");
    default:
      return menu(t, "OTHER_HELP");
  }
}

// ── booking ────────────────────────────────────────────────────

function mergeWho(t: Turn, e: Extraction): void {
  const p = t.conv.p;
  if (e.forWhom === "self") { p.forWhom = "self"; p.profileId = t.profiles.find((x) => x.relation === "SELF")?.id; }
  else if (e.forWhom === "existing_profile" && e.profileRef) { p.forWhom = "existing_profile"; p.profileId = t.profiles.find((x) => x.ref === e.profileRef)?.id; }
  else if (e.forWhom === "new_person" || e.newPersonName) {
    const match = matchProfileByName(t.profiles, e.newPersonName);
    if (match) { p.forWhom = "existing_profile"; p.profileId = match.id; }
    else { p.forWhom = "new_person"; p.profileId = undefined; p.newName = e.newPersonName ?? undefined; p.relation = (e.relation as Relation) ?? p.relation; }
  }
  if (e.relation && !p.relation && e.relation !== "SELF") p.relation = e.relation as Relation;
  if (e.visitType) p.visitType = e.visitType;
}

function mergeWhen(t: Turn, e: Extraction): void {
  const p = t.conv.p;
  if (e.date) p.date = e.date;
  if (e.time) { p.time = T.toMin(e.time); p.tq = e.timeQualifier; }
  if (e.partOfDay) p.pod = e.partOfDay;
  if (e.date && !e.time && !e.partOfDay) { p.time = null; p.pod = null; }
}

async function startBooking(t: Turn, e: Extraction): Promise<void> {
  if (t.conv.p.intent !== "BOOK" || t.conv.state === "IDLE") t.conv.p = { intent: "BOOK" };
  mergeWho(t, e);
  mergeWhen(t, e);
  return progressBooking(t);
}

/** The person chatting (account owner), as opposed to the patient being booked. */
function senderName(t: Turn): string | null {
  const self = t.profiles.find((x) => x.relation === "SELF");
  return self ? firstName(self.name) : waName(t.acc);
}

function currentName(t: Turn): string | null {
  const id = t.conv.p.profileId;
  const p = id ? t.profiles.find((x) => x.id === id) : t.profiles.find((x) => x.relation === "SELF");
  return p ? firstName(p.name) : waName(t.acc);
}

async function resolveProfile(t: Turn): Promise<boolean> {
  const p = t.conv.p;
  if (p.profileId && t.profiles.some((x) => x.id === p.profileId)) return true;
  if ((p.forWhom === "self" || p.forSelf) && !t.profiles.length && !p.whoAsked) {
    // Brand-new patient: always confirm who the visit is for (approved S1 flow).
    p.forWhom = "unknown";
  }
  if (p.forWhom === "self" || p.forSelf) {
    const self = t.profiles.find((x) => x.relation === "SELF");
    if (self) { p.profileId = self.id; return true; }
    const nm = p.newName ?? waName(t.acc);
    if (!nm) { p.forSelf = true; t.set("BK_NAME"); await t.text("ASK_NAME_SELF"); return false; }
    const created = await createProfile(t.ctx, t.acc.id, nm, "SELF");
    if (p.altPhone) await t.ctx.db.patientProfile.update({ where: { id: created.id }, data: { contactPhone: encrypt(p.altPhone) } });
    t.profiles = await profilesOf(t.ctx, t.acc.id);
    p.profileId = created.id;
    p.newName = undefined;
    return true;
  }
  if (p.forWhom === "new_person") {
    if (!p.newName) {
      const byRel = p.relation ? t.profiles.find((x) => x.relation === p.relation) : undefined;
      if (byRel) { p.profileId = byRel.id; return true; }
      t.set("BK_NAME");
      await t.text("ASK_NAME_OTHER");
      return false;
    }
    const created = await createProfile(t.ctx, t.acc.id, p.newName, p.relation ?? "OTHER");
    t.profiles = await profilesOf(t.ctx, t.acc.id);
    p.profileId = created.id;
    return true;
  }
  // unknown
  p.whoAsked = true;
  const self = t.profiles.find((x) => x.relation === "SELF");
  if (t.profiles.length === 1 && self) { p.profileId = self.id; return true; }
  t.set("BK_WHO");
  if (!t.profiles.length) {
    await t.buttons(t.t("ASK_WHO"), "ASK_WHO", [{ id: "who:me", title: t.b("FOR_ME") }, { id: "who:other", title: t.b("SOMEONE_ELSE") }]);
  } else {
    const others = t.profiles.filter((x) => x.relation !== "SELF").slice(0, self ? 1 : 2);
    const btns: Button[] = [];
    if (self) btns.push({ id: "who:me", title: t.b("FOR_ME") });
    for (const o of others) btns.push({ id: `who:${o.id}`, title: firstName(o.name).slice(0, 20) });
    btns.push({ id: "who:other", title: t.b("SOMEONE_ELSE") });
    const body = self && others[0] ? t.t("ASK_WHO_RETURNING", { name: firstName(self.name), other: firstName(others[0].name) }) : t.t("ASK_WHO");
    await t.buttons(body, "ASK_WHO", btns.slice(0, 3));
  }
  return false;
}

async function progressBooking(t: Turn): Promise<void> {
  t.conv.p.intent ??= "BOOK";
  if (!(await resolveProfile(t))) return;
  const p = t.conv.p;
  if (p.intent === "BOOK") {
    const n = await activeCountForProfile(t.ctx, p.profileId!);
    if (n >= t.info.settings.maxActiveBookingsPerProfile) {
      const up = (await upcomingForAccount(t.ctx, t.acc.id)).filter((u) => u.profileId === p.profileId);
      t.set("IDLE");
      return t.buttons(t.t("RULE_PROFILE_LIMIT", { name: currentName(t), n, list: up.map((u) => fmtAppt(t, u)).join(", ") }), "RULE_PROFILE_LIMIT",
        up.slice(0, 3).map((u) => ({ id: `rs:${u.id}`, title: `${T.fmtDayShort(T.localDate(u.slotStart, t.ctx.tz), "en").slice(0, 10)} ${T.fmtTime(T.localMinutes(u.slotStart, t.ctx.tz))}`.slice(0, 20) })));
    }
  }
  if (t.conv.state === "BK_NAME" || t.conv.state === "BK_WHO") await t.text("ACK_PROFILE", { name: currentName(t) });
  if (p.date || p.time != null || p.pod) return offer(t);
  if (p.intent === "BOOK" && flowReady(t)) return openFlow(t);
  return askWhen(t);
}

async function askWhen(t: Turn): Promise<void> {
  t.set("BK_WHEN");
  t.conv.raceLost = false;
  if (t.conv.p.intent !== "RESCHEDULE") return t.text("ASK_WHEN");
  // Rescheduling: the next three days with free slots (today first) as buttons, or type a preferred day and time.
  const avail = await windowAvailability(t.ctx, t.info);
  const today = nowLocal(t.ctx).date;
  const days: string[] = [];
  for (let i = 0; i <= t.info.settings.windowDays && days.length < 3; i++) { const d = T.addDays(today, i); if (S.freeSlotsOn(d, avail).length) days.push(d); }
  if (!days.length) return t.text("RS_ASK_WHEN");
  const label = (d: string) => {
    const [wd, day] = T.fmtDayShort(d, t.lang).split(" ");
    const rel = d === today ? t.b("TODAY") : d === T.addDays(today, 1) ? t.b("TOMORROW") : null;
    return (rel ? `${rel} · ${wd} ${day}` : T.fmtDayShort(d, t.lang)).slice(0, 20);
  };
  return t.buttons(t.t("RS_ASK_WHEN"), "RS_ASK_WHEN", days.map((d) => ({ id: `rsday:${d}`, title: label(d) })));
}

async function answerWho(t: Turn, e: Extraction): Promise<void> {
  t.conv.p.whoAsked = true;
  mergeWho(t, e);
  if (e.selfName && t.conv.p.forWhom !== "new_person") { t.conv.p.forWhom = "self"; t.conv.p.newName = e.selfName; }
  mergeWhen(t, e);
  if (t.conv.p.forWhom === undefined || (t.conv.p.forWhom === "unknown" && !t.conv.p.profileId)) {
    if (e.intent === "AFFIRM") t.conv.p.forWhom = "self";
    else return resolveProfile(t).then(() => undefined);
  }
  return progressBooking(t);
}

async function answerName(t: Turn, e: Extraction): Promise<void> {
  const nm = e.newPersonName ?? e.selfName;
  if (!nm) return t.text(t.conv.p.forSelf ? "ASK_NAME_SELF" : "ASK_NAME_OTHER");
  if (e.relation && e.relation !== "SELF") t.conv.p.relation = e.relation as Relation;
  t.conv.p.newName = nm;
  if (!t.conv.p.forSelf) t.conv.p.forWhom = "new_person";
  mergeWhen(t, e);
  return progressBooking(t);
}

async function answerWhen(t: Turn, e: Extraction): Promise<void> {
  if (!(e.date || e.time || e.partOfDay)) {
    if (e.intent === "AFFIRM" && t.conv.offered?.length === 1) return choose(t, t.conv.offered[0]!);
    // Don't repeat the same question: offer the free times, or a way out.
    return t.buttons(t.t("ASK_WHEN_RETRY"), "ASK_WHEN_RETRY", [{ id: "see_all", title: t.b("SHOW_FREE_TIMES") }, { id: "bk:stop", title: t.b("STOP_BOOKING") }]);
  }
  // "same day" while rescheduling → keep the old appointment's date
  if (!e.date && t.conv.p.intent === "RESCHEDULE" && t.conv.p.rescheduleId) {
    const old = await t.ctx.db.appointment.findUnique({ where: { id: t.conv.p.rescheduleId } });
    if (old) e = { ...e, date: T.localDate(old.slotStart, t.ctx.tz) };
  }
  mergeWhen(t, e);
  return offer(t);
}

function defaultDate(t: Turn): string {
  const n = nowLocal(t.ctx);
  const p = t.conv.p;
  if (p.date) return p.date;
  const cutoff = n.min + t.info.settings.cutoffMinutes;
  if (p.time != null) return p.time > cutoff ? n.date : T.addDays(n.date, 1);
  if (p.pod) return T.PART_OF_DAY_RANGE[p.pod][1] > cutoff ? n.date : T.addDays(n.date, 1);
  return n.date;
}

function podLabel(t: Turn, pod: Extraction["partOfDay"] | null | undefined): string {
  if (!pod) return "";
  const m = { en: { morning: "morning", afternoon: "afternoon", evening: "evening", night: "night" }, hi: { morning: "सुबह", afternoon: "दोपहर", evening: "शाम", night: "रात" }, hinglish: { morning: "subah", afternoon: "dopahar", evening: "shaam", night: "raat" } };
  return m[t.lang][pod];
}

function slotBtn(s: SlotRef): Button { return { id: `slot:${s.date}|${s.startMin}`, title: T.fmtTime(s.startMin) }; }

async function offer(t: Turn): Promise<void> {
  const avail = await windowAvailability(t.ctx, t.info);
  const n = nowLocal(t.ctx);
  const p = t.conv.p;
  const date = defaultDate(t);
  t.conv.requested = { date, time: p.time, pod: p.pod };
  const diff = T.daysBetween(n.date, date);
  if (diff < 0) { await t.text("RULE_PAST"); return askWhen(t); }
  if (diff > t.info.settings.windowDays) {
    await t.text("RULE_TOO_FAR", { windowDays: t.info.settings.windowDays, maxDate: T.fmtDate(T.addDays(n.date, t.info.settings.windowDays), t.lang) });
    return askWhen(t);
  }
  if (!S.sessionsOn(date, avail.sessions, avail.closures).length) {
    await t.text("RULE_CLOSED", { date: T.fmtDayShort(date, t.lang) });
    // Keep the requested part of day / time on the next open day ("kal shaam" on a Sunday → Monday evening).
    const nextOpen = S.firstDateWithFree(T.addDays(date, 1), avail);
    if (!nextOpen) return callClinic(t);
    p.date = nextOpen;
    if (p.time != null) p.tq = "around"; // we changed the day, so offer choices rather than auto-booking
    return offer(t);
  }
  // Exact time asked: book it straight away if free; if taken, say so (family → the very next slot).
  if (p.time != null && (p.tq === "exact" || p.tq == null)) {
    const exact = S.findSlot(date, p.time, avail);
    // Only an explicit exact time ("book 6:10") is taken straight away; ranges/unclear → offer nearest.
    if (p.tq === "exact" && exact && S.bookability(exact, avail) === "ok") return choose(t, { date, startMin: p.time });
    if (exact && S.bookability(exact, avail) === "taken") {
      const at = slotInstant(t.ctx, exact);
      const holder = await t.ctx.db.appointment.findFirst({ where: { doctorId: t.info.doctor.id, slotStart: at, slotKey: { not: null } }, include: { profile: true } });
      if (holder?.profile?.accountId === t.acc.id && holder.profileId !== p.profileId) {
        const nxt = S.nextAdjacentFree(exact, avail);
        if (nxt) {
          t.conv.offered = [{ date: nxt.date, startMin: nxt.startMin }];
          t.conv.requested = { date, time: p.time };
          t.set("BK_SAME_FAMILY");
          return t.buttons(t.t("SAME_SLOT_FAMILY", { time: T.fmtTime(p.time), otherName: firstName(decrypt(holder.profile.name)), name: currentName(t), nextSlot: T.fmtTime(nxt.startMin) }), "SAME_SLOT_FAMILY",
            [{ id: `slot:${nxt.date}|${nxt.startMin}`, title: t.b("BOOK_SLOT", { time: T.fmtTime(nxt.startMin) }) }, { id: "see_all", title: t.b("SEE_ALL") }]);
        }
      }
      const alt = S.findNearSlots({ date, time: p.time, exclude: new Set([S.slotRef(date, p.time)]) }, avail);
      if (alt.near.length) {
        t.conv.offered = alt.near.map((s) => ({ date: s.date, startMin: s.startMin }));
        t.set("BK_PICK_SLOT");
        return t.buttons(t.t("SLOT_TAKEN_TYPED", { time: T.fmtTime(p.time) }), "SLOT_TAKEN_TYPED", [...t.conv.offered.map(slotBtn), { id: "see_all", title: t.b("SEE_ALL") }]);
      }
    }
  }
  const r = S.findNearSlots({ date, time: p.time, timeQualifier: p.tq, partOfDay: p.pod }, avail);
  const vars = { dayLabel: T.fmtDayLabel(date, n.date, t.lang), date: T.fmtDate(date, t.lang), partOfDay: podLabel(t, p.pod ?? (p.time != null ? T.partOfDayOf(p.time) : null)), requestedTime: p.time != null ? T.fmtTime(p.time) : "" };
  if (r.near.length) {
    t.conv.offered = r.near.map((s) => ({ date: s.date, startMin: s.startMin }));
    t.set("BK_PICK_SLOT");
    const body = p.time != null ? t.t("OFFER_NEAR_TIME", vars) : t.t("OFFER_EARLIEST", vars);
    return t.buttons(body, "OFFER_NEAR_SLOTS", [...t.conv.offered.map(slotBtn), { id: "see_all", title: t.b("SEE_ALL") }]);
  }
  await t.text(p.time != null ? "NO_NEAR_SLOTS" : "NO_SLOTS_DAY", vars);
  return slotPicker(t, r.hasAny ? date : (S.firstDateWithFree(date, avail) ?? date), true);
}

function flowReady(t: Turn): boolean {
  if (t.info.settings.slotPicker === "chat") return false; // the clinic chose the in-chat format
  if (t.conv.pickerFailedAt && t.ctx.clock.now().getTime() - t.conv.pickerFailedAt < 3600_000) return false;
  return t.ctx.env.BOOKING_PAGE || !!(t.info.settings.flowsEnabled && t.ctx.env.WA_FLOW_ID_BOOKING && t.ctx.flowKey);
}

/** Form D: the WhatsApp booking form (date chips, Morning / Evening slot chips). */
async function openFlow(t: Turn): Promise<void> {
  const name = currentName(t) ?? "";
  const token = randomBytes(24).toString("base64url");
  await t.ctx.db.flowToken.create({ data: { token, accountId: t.acc.id, profileId: t.conv.p.profileId ?? null, expiresAt: new Date(t.ctx.clock.now().getTime() + 15 * 60_000) } });
  t.set("BK_FLOW_OPEN");
  if (t.ctx.env.BOOKING_PAGE) {
    // The booking page: scrollable dates and Morning/Evening slots, any number of slots, confirm screen (form D).
    await t.ctx.db.flowToken.update({ where: { token }, data: { expiresAt: new Date(t.ctx.clock.now().getTime() + 30 * 60_000) } });
    const url = `${t.ctx.env.PUBLIC_BASE_URL}${t.ctx.env.BASE_PATH}/book?t=${token}`;
    const ok = await t.send({ kind: "cta_url", body: t.t("BOOK_LINK_BODY", { name }), displayText: t.b("CHOOSE_DATE_TIME"), url }, "BOOK_LINK");
    if (ok) return;
    t.conv.pickerFailedAt = t.ctx.clock.now().getTime();
    t.ctx.log.warn({}, "booking_link_send_failed_using_list");
    return slotPicker(t, t.conv.requested?.date ?? nowLocal(t.ctx).date);
  }
  const sent = await t.send({ kind: "flow", body: t.t("FLOW_BODY", { name }), cta: t.b("CHOOSE_DATE_TIME"), flowId: t.ctx.env.WA_FLOW_ID_BOOKING!, flowToken: token, screen: "PICK_DATE_SLOT", draft: t.ctx.env.WA_FLOW_MODE === "draft" }, "FLOW_BOOKING");
  if (sent) return;
  t.conv.pickerFailedAt = t.ctx.clock.now().getTime();
  t.ctx.log.warn({}, "flow_send_failed_using_list");
  return slotPicker(t, t.conv.requested?.date ?? nowLocal(t.ctx).date);
}

/** Form D when available, else the list picker (form C): one day, split by session when it wouldn't fit in 10 rows. */
async function slotPicker(t: Turn, fromDate: string, introSent = false, session?: string): Promise<void> {
  void introSent;
  if (flowReady(t) && t.conv.p.intent !== "RESCHEDULE") return openFlow(t);
  const name = currentName(t) ?? "";
  const avail = await windowAvailability(t.ctx, t.info);
  let day: string | null = null;
  for (let i = 0; i <= t.info.settings.windowDays && !day; i++) { const d = T.addDays(fromDate, i); if (S.freeSlotsOn(d, avail).length) day = d; }
  if (!day) return callClinic(t);
  const bySession = new Map<string, S.Slot[]>();
  for (const s of S.freeSlotsOn(day, avail)) bySession.set(s.sessionLabel, [...(bySession.get(s.sessionLabel) ?? []), s]);
  const total = [...bySession.values()].reduce((n, ss) => n + ss.length, 0);
  t.conv.requested = { ...t.conv.requested, date: day };
  if (!session && total > 10 && bySession.size > 1) {
    t.set("BK_PICK_SLOT");
    t.conv.offered = [];
    const dayLabel = T.fmtDayLabel(day, nowLocal(t.ctx).date, t.lang);
    // Each session with its clinic hours, e.g. "Morning (10am–1pm)", "Evening (5:10–8pm)" (buttons hold 20 characters).
    const sessionOf = new Map(t.info.sessions.map((x) => [x.id, x]));
    const hours = new Map<string, string>();
    for (const s of S.allSlotsOn(day, avail)) {
      const def = sessionOf.get(s.sessionId);
      if (def && !hours.has(s.sessionLabel)) hours.set(s.sessionLabel, T.fmtShortRange(T.toMin(def.startTime), T.toMin(def.endTime)));
    }
    const title = (label: string) => {
      const span = hours.get(label) ?? "";
      return [`${label} (${span})`, `${label} ${span}`, span].find((x) => span && [...x].length <= 20) ?? label.slice(0, 20);
    };
    return t.buttons(t.t("LIST_PICK_SESSION", { dayLabel }), "LIST_PICK_SESSION",
      [...bySession.keys()].slice(0, 3).map((label) => ({ id: `sess:${day}|${label}`, title: title(label) })));
  }
  const sections: ListSection[] = [];
  const offered: SlotRef[] = [];
  for (const [label, ss] of bySession) {
    if (session && label !== session) continue;
    const take = ss.slice(0, 10 - offered.length);
    if (!take.length) break;
    sections.push({ title: `${label} · ${T.fmtDayShort(day, "en")}`.slice(0, 24), rows: take.map((s) => ({ id: `slot:${s.date}|${s.startMin}`, title: T.fmtTime(s.startMin) })) });
    offered.push(...take.map((s) => ({ date: s.date, startMin: s.startMin })));
  }
  if (!offered.length) return callClinic(t);
  t.conv.offered = offered;
  t.set("BK_PICK_SLOT");
  { await t.send({ kind: "list", body: t.t("LIST_PICKER", { name }), button: t.b("VIEW_SLOTS"), sections }, "LIST_PICKER"); return; }
}

async function answerPick(t: Turn, e: Extraction): Promise<void> {
  const offered = t.conv.offered ?? [];
  if (e.time) {
    const min = T.toMin(e.time);
    const date = e.date ?? offered.find((o) => o.startMin === min)?.date ?? t.conv.requested?.date ?? defaultDate(t);
    const avail = await windowAvailability(t.ctx, t.info);
    const slot = S.findSlot(date, min, avail);
    if (slot && S.bookability(slot, avail) === "ok") return choose(t, { date, startMin: min });
    if (e.intent === "DENY" && t.conv.raceLost) return raceDeclined(t, min);
    t.conv.p.date = date; t.conv.p.time = min; t.conv.p.tq = "around";
    const r = S.findNearSlots({ date, time: min, exclude: slot ? new Set([S.slotRef(date, min)]) : undefined }, avail);
    if (r.near.length) {
      t.conv.offered = r.near.map((s) => ({ date: s.date, startMin: s.startMin }));
      t.set("BK_PICK_SLOT");
      const id: C.CopyId = slot ? "SLOT_TAKEN_TYPED" : "OFFER_NEAR_TIME";
      return t.buttons(t.t(id, { time: T.fmtTime(min), dayLabel: T.fmtDayLabel(date, nowLocal(t.ctx).date, t.lang), date: T.fmtDate(date, t.lang), partOfDay: podLabel(t, T.partOfDayOf(min)), requestedTime: T.fmtTime(min) }), id, [...t.conv.offered.map(slotBtn), { id: "see_all", title: t.b("SEE_ALL") }]);
    }
    if (t.conv.raceLost) return raceDeclined(t, min);
    return offer(t);
  }
  if (e.intent === "AFFIRM" && offered.length === 1) return choose(t, offered[0]!);
  if (e.intent === "DENY") return t.conv.raceLost ? raceDeclined(t, t.conv.requested?.time ?? null) : otherTimesOrStop(t);
  if (e.date || e.partOfDay) { mergeWhen(t, e); return offer(t); }
  if (offered.length) return t.buttons(t.t("OFFER_NEXT_AVAILABLE"), "OFFER_NEAR_SLOTS", [...offered.slice(0, 2).map(slotBtn), { id: "see_all", title: t.b("SEE_ALL") }]);
  return askWhen(t);
}

async function raceDeclined(t: Turn, min: number | null | undefined): Promise<void> {
  t.set("BK_RACE_DECLINED");
  const date = t.conv.requested?.date ?? nowLocal(t.ctx).date;
  return t.buttons(t.t("SLOT_RACE_DECLINED", { requestedTime: min != null ? T.fmtTime(min) : "", dayLabel: T.fmtDayLabel(date, nowLocal(t.ctx).date, t.lang) }), "SLOT_RACE_DECLINED",
    [{ id: "race:another", title: t.b("TRY_ANOTHER_DAY") }, { id: "call", title: t.b("CALL_CLINIC") }]);
}

async function choose(t: Turn, ref: SlotRef): Promise<void> {
  if (!t.conv.p.profileId && !(await resolveProfile(t))) return;
  const avail = await windowAvailability(t.ctx, t.info);
  const slot = S.findSlot(ref.date, ref.startMin, avail);
  if (!slot) return offer(t);
  const reason = S.bookability(slot, avail);
  if (reason === "cutoff" || reason === "past") {
    await t.text("RULE_CUTOFF", { time: T.fmtTime(ref.startMin), cutoff: t.info.settings.cutoffMinutes });
    t.conv.p.time = ref.startMin; t.conv.p.date = ref.date;
    return offer(t);
  }
  if (t.conv.held) { await releaseHold(t.ctx, t.conv.held); t.conv.held = undefined; }
  try {
    const held = await holdSlot(t.ctx, slot, t.conv.p.profileId!, t.acc.id);
    t.conv.held = held.id;
    t.conv.offered = [ref];
    // Nothing is booked or moved without the patient confirming (a reschedule keeps its visit type).
    if (t.conv.p.visitType || t.conv.p.intent === "RESCHEDULE") return askConfirm(t);
    return askVisitType(t);
  } catch (err) {
    if (err instanceof FamilySlotError) {
      const other = t.profiles.find((x) => x.id === err.otherProfileId);
      const nxt = S.nextAdjacentFree(slot, avail);
      if (!nxt) return raceLost(t, ref);
      t.conv.offered = [{ date: nxt.date, startMin: nxt.startMin }];
      t.set("BK_SAME_FAMILY");
      return t.buttons(t.t("SAME_SLOT_FAMILY", { time: T.fmtTime(ref.startMin), otherName: other ? firstName(other.name) : "", name: currentName(t), nextSlot: T.fmtTime(nxt.startMin) }), "SAME_SLOT_FAMILY",
        [{ id: `slot:${nxt.date}|${nxt.startMin}`, title: t.b("BOOK_SLOT", { time: T.fmtTime(nxt.startMin) }) }, { id: "see_all", title: t.b("SEE_ALL") }]);
    }
    if (err instanceof SlotTakenError) return raceLost(t, ref);
    throw err;
  }
}

async function raceLost(t: Turn, ref: SlotRef): Promise<void> {
  const avail = await windowAvailability(t.ctx, t.info);
  const r = S.findNearSlots({ date: ref.date, time: ref.startMin, exclude: new Set([S.slotRef(ref.date, ref.startMin)]) }, avail);
  t.conv.raceLost = true;
  t.conv.requested = { date: ref.date, time: ref.startMin };
  if (!r.near.length) return raceDeclined(t, ref.startMin);
  t.conv.offered = r.near.map((s) => ({ date: s.date, startMin: s.startMin }));
  t.set("BK_PICK_SLOT");
  return t.buttons(t.t("SLOT_RACE_LOST", { name: currentName(t), time: T.fmtTime(ref.startMin) }), "SLOT_RACE_LOST", [...t.conv.offered.map(slotBtn), { id: "see_all", title: t.b("SEE_ALL") }]);
}

async function askVisitType(t: Turn): Promise<void> {
  t.set("BK_VISIT_TYPE");
  const s = t.conv.offered?.[0];
  const head = s ? `${t.t("SLOT_HELD", { name: currentName(t), dayShort: T.fmtDayShort(s.date, t.lang), time: T.fmtTime(s.startMin) })}\n` : "";
  return t.buttons(head + t.t("ASK_VISIT_TYPE"), "ASK_VISIT_TYPE", [{ id: "vt:NEW", title: t.b("NEW") }, { id: "vt:FOLLOW_UP", title: t.b("FOLLOW_UP") }, { id: "vt:REPORT_SHOW", title: t.b("REPORT_SHOW") }]);
}

/** Nothing is booked until the patient sees the summary and confirms it. */
async function askConfirm(t: Turn): Promise<void> {
  const s = t.conv.offered?.[0];
  if (!t.conv.held || !s) return finalize(t);
  t.set("BK_CONFIRM");
  if (t.conv.p.intent === "RESCHEDULE" && t.conv.p.rescheduleId) {
    const old = await t.ctx.db.appointment.findUnique({ where: { id: t.conv.p.rescheduleId } });
    if (old) {
      return t.buttons(t.t("RS_CONFIRM_ASK", { name: currentName(t), oldDay: T.fmtDayShort(T.localDate(old.slotStart, t.ctx.tz), t.lang), oldTime: T.fmtTime(T.localMinutes(old.slotStart, t.ctx.tz)), dayShort: T.fmtDayShort(s.date, t.lang), time: T.fmtTime(s.startMin) }), "RS_CONFIRM_ASK",
        [{ id: "bk:yes", title: t.b("CONFIRM_CHANGE") }, { id: "bk:change", title: t.b("CHANGE_TIME") }]);
    }
  }
  const vt = t.conv.p.visitType ?? "NEW";
  const visit = t.b(vt === "FOLLOW_UP" ? "FOLLOW_UP" : vt === "REPORT_SHOW" ? "REPORT_SHOW" : "NEW");
  return t.buttons(t.t("CONFIRM_BOOKING_ASK", { name: currentName(t), dayShort: T.fmtDayShort(s.date, t.lang), time: T.fmtTime(s.startMin), visit }), "CONFIRM_BOOKING_ASK",
    [{ id: "bk:yes", title: t.b("CONFIRM_BOOKING") }, { id: "bk:change", title: t.b("CHANGE_TIME") }]);
}

async function changeTime(t: Turn): Promise<void> {
  const date = t.conv.offered?.[0]?.date ?? t.conv.requested?.date ?? nowLocal(t.ctx).date;
  if (t.conv.held) { await releaseHold(t.ctx, t.conv.held); t.conv.held = undefined; }
  t.conv.offered = undefined;
  return slotPicker(t, date);
}

async function finalize(t: Turn): Promise<void> {
  if (!t.conv.held) return t.conv.offered?.[0] ? choose(t, t.conv.offered[0]) : askWhen(t);
  const ref = t.conv.offered?.[0];
  try {
    const p = t.conv.p;
    let appt;
    if (p.intent === "RESCHEDULE" && p.rescheduleId) {
      const r = await reschedule(t.ctx, p.rescheduleId, t.conv.held);
      appt = r.booked;
      const oldMin = T.localMinutes(r.old.slotStart, t.ctx.tz);
      await t.text("RS_DONE", { name: currentName(t), dayShort: T.fmtDayShort(T.localDate(appt.slotStart, t.ctx.tz), t.lang), time: T.fmtTime(T.localMinutes(appt.slotStart, t.ctx.tz)), token: appt.token, oldTime: T.fmtTime(oldMin) });
    } else {
      appt = await confirmHold(t.ctx, t.conv.held, p.visitType ?? "NEW");
      const date = T.localDate(appt.slotStart, t.ctx.tz);
      const visit = t.b(appt.visitType === "FOLLOW_UP" ? "FOLLOW_UP" : appt.visitType === "REPORT_SHOW" ? "REPORT_SHOW" : "NEW");
      await t.buttons(t.t("BOOKING_CONFIRMED", { name: currentName(t), dayShort: T.fmtDayShort(date, t.lang), time: T.fmtTime(T.localMinutes(appt.slotStart, t.ctx.tz)), token: appt.token, visit }), "BOOKING_CONFIRMED",
        [{ id: `appt:rs:${appt.id}`, title: t.b("RESCHEDULE") }, { id: `appt:cx:${appt.id}`, title: t.b("CANCEL") }]);
    }
    t.conv.p = { profileId: p.profileId };
    t.conv.held = undefined;
    t.conv.offered = undefined;
    t.conv.raceLost = false;
    t.set("IDLE");
  } catch (err) {
    if (err instanceof SlotTakenError && ref) { t.conv.held = undefined; return raceLost(t, ref); }
    throw err;
  }
}

async function onFlowCompleted(t: Turn, resp: Record<string, unknown>): Promise<void> {
  if (!(await gates(t, null))) return;
  const slot = String(resp.slot ?? "");
  const [date, min] = slot.split("|");
  const token = typeof resp.flow_token === "string" ? resp.flow_token : null;
  if (token) {
    const ft = await t.ctx.db.flowToken.findUnique({ where: { token } });
    if (ft?.profileId) t.conv.p.profileId = ft.profileId;
    if (ft && typeof resp.held === "string") t.conv.held = resp.held;
  }
  if (!date || !min) return askWhen(t);
  t.conv.p.intent ??= "BOOK";
  return choose(t, { date, startMin: Number(min) });
}

// ── manage bookings ────────────────────────────────────────────

function fmtAppt(t: Turn, u: UpcomingView): string {
  return `${firstName(u.profileName)} – ${T.fmtDayShort(T.localDate(u.slotStart, t.ctx.tz), t.lang)} ${T.fmtTime(T.localMinutes(u.slotStart, t.ctx.tz))}`;
}

function filterUpcoming(t: Turn, up: UpcomingView[], e: Extraction | null): UpcomingView[] {
  let out = up;
  if (e?.profileRef) { const pid = t.profiles.find((x) => x.ref === e.profileRef)?.id; const f = out.filter((u) => u.profileId === pid); if (f.length) out = f; }
  if (e?.date) { const f = out.filter((u) => T.localDate(u.slotStart, t.ctx.tz) === e.date); if (f.length) out = f; }
  return out;
}

async function startReschedule(t: Turn, e: Extraction | null): Promise<void> {
  const up = filterUpcoming(t, (await upcomingForAccount(t.ctx, t.acc.id)).filter((u) => u.status === "BOOKED"), e && !(e.time || e.partOfDay) ? e : e ? { ...e, date: null } : null);
  if (!up.length) { t.set("IDLE"); return t.buttons(t.t("NO_UPCOMING"), "NO_UPCOMING", [{ id: "menu:book", title: t.b("BOOK") }]); }
  if (up.length === 1) return beginReschedule(t, up[0]!.id, e);
  t.set("RS_PICK_APPT");
  { await t.send({ kind: "list", body: t.t("RS_PICK_APPT"), button: t.b("MY_APPTS"), sections: [{ title: "Appointments", rows: up.slice(0, 10).map((u) => ({ id: `rs:${u.id}`, title: apptWhen(t, u).slice(0, 24), description: `${firstName(u.profileName)}${u.token ? ` · ${u.token}` : ""}`.slice(0, 72) })) }] }, "RS_PICK_APPT"); return; }
}

async function beginReschedule(t: Turn, apptId: string, e: Extraction | null): Promise<void> {
  const a = await t.ctx.db.appointment.findUnique({ where: { id: apptId }, include: { profile: true } });
  if (!a || a.profile?.accountId !== t.acc.id || a.status !== "BOOKED") return myAppointments(t);
  t.conv.p = { intent: "RESCHEDULE", rescheduleId: a.id, profileId: a.profileId!, visitType: a.visitType ?? undefined };
  t.conv.offered = undefined;
  if (e && (e.date || e.time || e.partOfDay)) {
    if (!e.date && (e.time || e.partOfDay)) e = { ...e, date: e.date };
    mergeWhen(t, e);
    return offer(t);
  }
  return askWhen(t);
}

function cxButtons(t: Turn): Button[] {
  return [{ id: `cx:yes:${t.conv.cxApptId}`, title: t.b("YES_CANCEL") }, { id: "cx:no", title: t.b("KEEP_IT") }];
}

/** Every upcoming appointment (or the ones the message points to), numbered, to cancel one, several or all. */
async function startCancel(t: Turn, e: Extraction | null, tapped?: string): Promise<void> {
  // "my appointment" doesn't narrow it to the patient's own booking: family bookings are listed too. A named person or day does.
  const self = t.profiles.find((x) => x.relation === "SELF")?.ref;
  const up = filterUpcoming(t, await upcomingForAccount(t.ctx, t.acc.id), e && e.profileRef === self ? { ...e, profileRef: null } : e);
  if (!up.length) { t.set("IDLE"); return t.buttons(t.t("NO_UPCOMING"), "NO_UPCOMING", [{ id: "menu:book", title: t.b("BOOK") }]); }
  if (up.length === 1) return askCancelConfirm(t, tapped ?? up[0]!.id);
  const shown = up.slice(0, 9); // a WhatsApp list holds 10 rows: 9 appointments + "All of these"
  t.conv.cxList = shown.map((u) => u.id);
  t.conv.cxIds = undefined;
  t.conv.cxApptId = undefined;
  t.set("CX_PICK_APPT");
  const list = shown.map((u, i) => `${i + 1}. ${fmtAppt(t, u)}${u.token ? ` (${u.token})` : ""}`).join("\n");
  const rows = shown.map((u, i) => ({ id: `cxp:${u.id}`, title: `${i + 1}. ${apptWhen(t, u)}`.slice(0, 24), description: `${firstName(u.profileName)}${u.token ? ` · ${u.token}` : ""}`.slice(0, 72) }));
  rows.push({ id: "cxp:all", title: t.b("ALL_OF_THESE", { n: shown.length }), description: "" });
  await t.send({ kind: "list", body: t.t("CX_PICK_MULTI", { list }), button: t.b("CHOOSE"), sections: [{ title: "Appointments", rows: rows.map((r) => (r.description ? r : { id: r.id, title: r.title })) }] }, "CX_PICK_APPT");
}

/** "Mon 12 Oct, 6:10 PM": fits a list row (24 characters), with the patient's name below it. */
function apptWhen(t: Turn, u: UpcomingView): string {
  return `${T.fmtDayShort(T.localDate(u.slotStart, t.ctx.tz), t.lang)}, ${T.fmtTime(T.localMinutes(u.slotStart, t.ctx.tz))}`;
}

/** "2", "1 and 3", "1,2", "first and third", "all", "dono" → those appointments from the numbered list (null if it isn't a pick). */
function pickFromList(text: string, ids: string[]): string[] | null {
  const s = text.toLowerCase().trim();
  if (/^(\s*(cancel|karo|kar|do|please|pls|them|these|the|appointments?|wale|wala)\s*)*(all|all of (them|these)|both|sab|sabhi|saare|sare|dono|सब|सभी|दोनों)(\s*(of them|cancel|karo|kar do|please|pls|wale|appointments?))*\s*$/.test(s)) return [...ids];
  const ORD: Record<string, number> = { first: 1, "1st": 1, pehla: 1, pehle: 1, pahla: 1, second: 2, "2nd": 2, doosra: 2, dusra: 2, third: 3, "3rd": 3, teesra: 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5 };
  const words = s.replace(/[,&+.#]/g, " ").split(/\s+/).filter(Boolean);
  const nums: number[] = [];
  for (const w of words) {
    if (/^\d{1,2}$/.test(w)) nums.push(Number(w));
    else if (ORD[w]) nums.push(ORD[w]);
    else if (!/^(and|aur|or|cancel|karo|kar|do|please|pls|number|numbers|no|nos|wala|wale|ko|appointment|appointments|the|one|ones|ki|ka)$/.test(w)) return null; // other words: not a pick
  }
  if (!nums.length || nums.some((x) => x < 1 || x > ids.length)) return null;
  return [...new Set(nums)].map((x) => ids[x - 1]!);
}

async function askCancelConfirm(t: Turn, apptId: string): Promise<void> {
  const a = await t.ctx.db.appointment.findUnique({ where: { id: apptId }, include: { profile: true } });
  if (!a || a.profile?.accountId !== t.acc.id || !["BOOKED", "ARRIVED"].includes(a.status)) return myAppointments(t);
  t.conv.cxApptId = a.id;
  t.conv.cxIds = undefined;
  t.set("CX_CONFIRM");
  return t.buttons(t.t("CX_CONFIRM", { name: firstName(decrypt(a.profile!.name)), dayShort: T.fmtDayShort(T.localDate(a.slotStart, t.ctx.tz), t.lang), time: T.fmtTime(T.localMinutes(a.slotStart, t.ctx.tz)) }), "CX_CONFIRM", cxButtons(t));
}

/** "Cancel all": every upcoming appointment, one confirmation. */
async function cancelAll(t: Turn): Promise<void> {
  const up = await upcomingForAccount(t.ctx, t.acc.id);
  if (!up.length) { t.set("IDLE"); return t.buttons(t.t("NO_UPCOMING"), "NO_UPCOMING", [{ id: "menu:book", title: t.b("BOOK") }]); }
  return up.length === 1 ? askCancelConfirm(t, up[0]!.id) : askCancelMany(t, up.map((u) => u.id));
}

/** Several appointments chosen: one confirmation for all of them. */
async function askCancelMany(t: Turn, ids: string[]): Promise<void> {
  const up = (await upcomingForAccount(t.ctx, t.acc.id)).filter((u) => ids.includes(u.id));
  if (!up.length) return startCancel(t, null);
  if (up.length === 1) return askCancelConfirm(t, up[0]!.id);
  t.conv.cxIds = up.map((u) => u.id);
  t.conv.cxApptId = undefined;
  t.set("CX_CONFIRM");
  return t.buttons(t.t("CX_CONFIRM_MANY", { n: up.length, list: up.map((u) => `• ${fmtAppt(t, u)}`).join("\n") }), "CX_CONFIRM_MANY",
    [{ id: "cx:many", title: t.b("YES_CANCEL_ALL") }, { id: "cx:no", title: t.b("KEEP_THEM") }]);
}

async function doCancel(t: Turn, apptId: string): Promise<void> {
  const a = await t.ctx.db.appointment.findUnique({ where: { id: apptId }, include: { profile: true } });
  if (!a || a.profile?.accountId !== t.acc.id) return myAppointments(t);
  if (["BOOKED", "ARRIVED", "HELD"].includes(a.status)) await cancelAppointment(t.ctx, apptId, "PATIENT", t.acc.id);
  return cancelled(t, 1);
}

async function doCancelMany(t: Turn): Promise<void> {
  const ids = t.conv.cxIds ?? [];
  const mine = await t.ctx.db.appointment.findMany({ where: { id: { in: ids }, profile: { accountId: t.acc.id }, status: { in: ["BOOKED", "ARRIVED", "HELD"] } } });
  if (!mine.length) { t.conv.cxIds = undefined; return myAppointments(t); }
  for (const a of mine) await cancelAppointment(t.ctx, a.id, "PATIENT", t.acc.id);
  return cancelled(t, mine.length);
}

/** After cancelling: say so, and if other bookings remain, offer to cancel another. */
async function cancelled(t: Turn, n: number): Promise<void> {
  t.conv.cxApptId = undefined;
  t.conv.cxIds = undefined;
  t.conv.cxList = undefined;
  t.set("IDLE");
  const rest = await upcomingForAccount(t.ctx, t.acc.id);
  if (!rest.length) return n > 1 ? t.text("CX_DONE_MANY", { n }) : t.text("CX_DONE");
  return t.buttons(t.t(n > 1 ? "CX_DONE_MANY_MORE" : "CX_DONE_MORE", { n, list: rest.map((u) => `• ${fmtAppt(t, u)}`).join("\n") }), "CX_DONE_MORE",
    [{ id: "cx:more", title: t.b("CANCEL_ANOTHER") }, { id: "cx:done", title: t.b("THATS_ALL") }]);
}

async function myAppointments(t: Turn): Promise<void> {
  const up = await upcomingForAccount(t.ctx, t.acc.id);
  if (!up.length) return t.buttons(t.t("NO_UPCOMING"), "NO_UPCOMING", [{ id: "menu:book", title: t.b("BOOK") }]);
  return t.text("MY_APPOINTMENTS", { list: up.map((u) => `• ${fmtAppt(t, u)}${u.token ? ` (${u.token})` : ""}`).join("\n") });
}

// ── queue: status / arrival ────────────────────────────────────

async function todayEntryFor(t: Turn) {
  const n = nowLocal(t.ctx);
  return t.ctx.db.queueEntry.findFirst({ where: { doctorId: t.info.doctor.id, date: T.dateToDb(n.date), profile: { accountId: t.acc.id }, state: { in: ["WAITING", "NEXT", "IN_CONSULT"] } }, orderBy: { arrivedAt: "desc" }, include: { profile: true } });
}

async function status(t: Turn): Promise<void> {
  const entry = await todayEntryFor(t);
  if (entry) {
    const name = firstName(decrypt(entry.profile!.name));
    if (entry.state === "IN_CONSULT") return t.text("YOUR_TURN");
    if (entry.state === "NEXT") return t.text("STATUS_NEXT", { name });
    const pos = await positionOf(t.ctx, entry.id);
    return t.text("STATUS", { current: pos?.snap.inConsult?.token ?? "—", token: entry.token, ahead: pos?.entry.ahead ?? 0, eta: Math.max(5, Math.round((pos?.entry.etaMin ?? 5) / 5) * 5) });
  }
  const n = nowLocal(t.ctx);
  const booked = (await upcomingForAccount(t.ctx, t.acc.id)).find((u) => T.localDate(u.slotStart, t.ctx.tz) === n.date && u.status === "BOOKED");
  if (booked) {
    const doc = await t.ctx.db.doctor.findUniqueOrThrow({ where: { id: t.info.doctor.id } });
    const late = doc.delayDate && T.dateFromDb(doc.delayDate) === n.date && doc.delayMinutes > 0 ? doc.delayMinutes : 0;
    return t.text("STATUS_BOOKED", { time: T.fmtTime(T.localMinutes(booked.slotStart, t.ctx.tz)), token: booked.token, runningStatus: late ? C.render("RUNNING_LATE", t.lang, { min: late }) : C.render("RUNNING_ON_TIME", t.lang) });
  }
  const next = (await upcomingForAccount(t.ctx, t.acc.id)).find((u) => u.status === "BOOKED");
  if (next) return t.text("STATUS_FUTURE", { name: firstName(next.profileName), dayShort: T.fmtDayShort(T.localDate(next.slotStart, t.ctx.tz), t.lang), time: T.fmtTime(T.localMinutes(next.slotStart, t.ctx.tz)), token: next.token ?? "" });
  return t.buttons(t.t("STATUS_NONE"), "STATUS_NONE", [{ id: "menu:book", title: t.b("BOOK") }]);
}

async function arrived(t: Turn): Promise<void> {
  const existing = await todayEntryFor(t);
  if (existing) {
    const pos = await positionOf(t.ctx, existing.id);
    return t.text("ALREADY_IN_QUEUE", { name: firstName(decrypt(existing.profile!.name)), token: existing.token, ahead: pos?.entry.ahead ?? 0, eta: Math.max(5, Math.round((pos?.entry.etaMin ?? 5) / 5) * 5) });
  }
  const n = nowLocal(t.ctx);
  const todays = (await upcomingForAccount(t.ctx, t.acc.id)).filter((u) => T.localDate(u.slotStart, t.ctx.tz) === n.date && u.status === "BOOKED");
  const noShow = await t.ctx.db.queueEntry.findFirst({ where: { doctorId: t.info.doctor.id, date: T.dateToDb(n.date), profile: { accountId: t.acc.id }, state: "NO_SHOW" } });
  if (!todays.length && noShow) {
    const { readd } = await import("./queue");
    await readd(t.ctx, noShow.id, { type: "PATIENT", id: t.acc.id });
    const pos = await positionOf(t.ctx, noShow.id);
    return t.text("ARRIVED_OK", { name: firstName(decrypt((await t.ctx.db.patientProfile.findUniqueOrThrow({ where: { id: noShow.profileId! } })).name)), token: noShow.token, ahead: pos?.entry.ahead ?? 0, eta: Math.max(5, Math.round((pos?.entry.etaMin ?? 5) / 5) * 5) });
  }
  if (!todays.length) return t.buttons(t.t("ARRIVED_NO_BOOKING"), "ARRIVED_NO_BOOKING", [{ id: "menu:book", title: t.b("CHECK_TIMES") }]);
  const a = todays[0]!;
  const slotMin = T.localMinutes(a.slotStart, t.ctx.tz);
  const name = firstName(a.profileName);
  if (slotMin - n.min > t.info.settings.earlyArrivalMinutes) {
    const at = new Date(a.slotStart.getTime() - t.info.settings.earlyCheckInMinutes * 60_000);
    await t.ctx.jobs.schedule("earlyCheckIn", { apptId: a.id }, at, `early:${a.id}`);
    return t.text("ARRIVED_EARLY", { name, time: T.fmtTime(slotMin), autoCheckIn: T.fmtTime(T.localMinutes(at, t.ctx.tz)) });
  }
  const entry = await arriveAppointment(t.ctx, a.id, { type: "PATIENT", id: t.acc.id });
  const pos = await positionOf(t.ctx, entry.id);
  await t.text("ARRIVED_OK", { name, token: entry.token, ahead: pos?.entry.ahead ?? 0, eta: Math.max(5, Math.round((pos?.entry.etaMin ?? 5) / 5) * 5) });
  return notifyIfNext(t.ctx, entry.id);
}

// ── walk-in ────────────────────────────────────────────────────

async function walkinAsk(t: Turn): Promise<void> {
  t.conv.p = { intent: "WALKIN" };
  t.set("WALKIN_ASK_NAME");
  const phone = displayPhone(t.waId);
  if (!t.profiles.length) return t.text("WALKIN_ASK_NAME", { waPhone: phone });
  const btns: Button[] = t.profiles.slice(0, 2).map((p) => ({ id: `wi:${p.id}`, title: (p.relation === "SELF" ? `${firstName(p.name)} (me)` : firstName(p.name)).slice(0, 20) }));
  btns.push({ id: "wi:other", title: t.b("SOMEONE_ELSE") });
  return t.buttons(t.t("WALKIN_ASK_NAME", { waPhone: phone }), "WALKIN_ASK_NAME", btns);
}

async function walkinName(t: Turn, e: Extraction): Promise<void> {
  const nm = e.selfName ?? e.newPersonName;
  if (e.profileRef) { const p = t.profiles.find((x) => x.ref === e.profileRef); if (p) return walkinIssue(t, p.id); }
  if (e.forWhom === "self") { const self = t.profiles.find((x) => x.relation === "SELF"); if (self) return walkinIssue(t, self.id); }
  if (!nm) return t.text("ASK_NAME_SELF");
  const match = matchProfileByName(t.profiles, nm);
  if (match) return walkinIssue(t, match.id);
  const rel: Relation = e.relation && e.relation !== "SELF" ? (e.relation as Relation) : t.profiles.some((p) => p.relation === "SELF") ? "OTHER" : "SELF";
  const created = await createProfile(t.ctx, t.acc.id, nm, rel);
  t.profiles = await profilesOf(t.ctx, t.acc.id);
  return walkinIssue(t, created.id);
}

async function walkinIssue(t: Turn, profileId: string): Promise<void> {
  t.conv.p.profileId = profileId;
  const name = currentName(t) ?? "";
  const r = await requestWalkin(t.ctx, t.acc.id, profileId);
  if (r.kind === "issued") {
    t.set("IDLE");
    t.conv.p = { profileId };
    await t.buttons(t.t("WALKIN_TOKEN", { name, token: r.token, ahead: r.ahead, eta: Math.max(5, Math.round(r.eta / 5) * 5) }), "WALKIN_TOKEN", [{ id: "menu:status", title: t.b("CHECK_STATUS") }]);
    return notifyIfNext(t.ctx, r.entryId);
  }
  if (r.kind === "overflow") { t.set("WI_AWAIT_STAFF"); return t.text("WALKIN_CHECKING", { name }); }
  t.set("IDLE");
  return t.buttons(t.t("WALKIN_CLOSED", { next: r.next ?? "" }), "WALKIN_CLOSED", [{ id: "menu:book", title: t.b("BOOK") }]);
}

/** Staff said no / timeout: offer the next bookable slots in the patient's chat. */
setOverflowDeclinedHandler(async (ctx, req, copyId) => {
  if (!req.accountId) return;
  const info = await clinicInfo(ctx);
  const acc = await ctx.db.patientAccount.findUniqueOrThrow({ where: { id: req.accountId } });
  const conv = await loadConv(ctx, acc);
  const t = new Turn(ctx, info, acc, decrypt(acc.waPhone), conv, await profilesOf(ctx, acc.id));
  const name = firstName(decrypt((await ctx.db.patientProfile.findUniqueOrThrow({ where: { id: req.profileId } })).name));
  const avail = await windowAvailability(ctx, info);
  const n = nowLocal(ctx);
  const next = S.nextFreeSlots(n.date, n.min, avail, 2);
  t.conv.p = { intent: "BOOK", profileId: req.profileId };
  t.conv.offered = next.map((s) => ({ date: s.date, startMin: s.startMin }));
  t.conv.requested = { date: next[0]?.date ?? n.date };
  t.set("BK_PICK_SLOT");
  const body = `${t.t(copyId, { name })}\n\n${t.t("OR_CALL_CLINIC")}`;
  const btns = next.map((s) => ({ id: `slot:${s.date}|${s.startMin}`, title: `${s.date === n.date ? "" : T.fmtDayShort(s.date, "en").slice(0, 6) + " "}${T.fmtTime(s.startMin)}`.slice(0, 20) }));
  await t.buttons(body, copyId, [...btns, { id: "see_all", title: t.b("SEE_ALL") }]);
  await saveConv(ctx, acc.id, t.conv);
});

// ── misc replies ───────────────────────────────────────────────

async function emergency(t: Turn): Promise<void> {
  const now = t.ctx.clock.now().getTime();
  if (t.conv.emergencyAt && now - t.conv.emergencyAt < 10 * 60_000) return;
  t.conv.emergencyAt = now;
  await t.ctx.db.messageLog.create({ data: { accountId: t.acc.id, direction: "OUT", kind: "emergency_reply_sent" } });
  await t.text("EMERGENCY_REPLY");
  await t.send({ kind: "contact", name: t.info.clinic.name, phone: t.info.clinic.phone }, "CLINIC_CONTACT");
}

async function callClinic(t: Turn): Promise<void> {
  t.set("IDLE");
  await t.text("CALL_CLINIC");
  await t.send({ kind: "contact", name: t.info.clinic.name, phone: t.info.clinic.phone }, "CLINIC_CONTACT");
}

async function menu(t: Turn, id: "MAIN_MENU" | "OTHER_HELP" | "BOOKING_STOPPED" | "STARTED_OVER" | "OFF_TOPIC" | "RUDE_REPLY" | "HELP_REPLY"): Promise<void> {
  const name = t.profiles.find((p) => p.relation === "SELF")?.name ?? waName(t.acc);
  // WhatsApp allows 3 buttons per message: the three main actions stay one tap away. Until the patient has chosen a
  // language, a small language bubble goes just above the menu (so the menu stays at the bottom, nearest the thumb).
  if (id === "MAIN_MENU" && !t.conv.langLock) {
    await t.buttons(t.t("LANGUAGE_OFFER"), "LANGUAGE_OFFER", [{ id: "lang:en", title: "English" }, { id: "lang:hi", title: "हिंदी" }, { id: "lang:hinglish", title: "Hinglish" }]);
  }
  const vars = { nameJi: t.nameJi(name ? firstName(name) : null) };
  // Rotating wording when the same kind of reply is needed again, so the patient never gets an identical message.
  const courtesy = id === "OFF_TOPIC" || id === "RUDE_REPLY" || id === "HELP_REPLY";
  const body = courtesy ? t.tv(id, vars) : t.fresh(id, vars);
  return t.buttons(body, id, [
    { id: "menu:book", title: t.b("BOOK") }, { id: "menu:appts", title: t.b("MY_APPTS") }, { id: "menu:status", title: t.b("QUEUE_STATUS") },
  ]);
}

async function askLanguage(t: Turn): Promise<void> {
  return t.buttons(t.t("LANGUAGE_PICK"), "LANGUAGE_PICK", [{ id: "lang:en", title: "English" }, { id: "lang:hi", title: "हिंदी" }, { id: "lang:hinglish", title: "Hinglish" }]);
}

/** The patient picked (or asked for) a language: use it from now on, whatever language they type in. */
async function setLanguage(t: Turn, lang: Lang): Promise<void> {
  t.conv.lang = lang;
  t.conv.langLock = true;
  await t.text("LANGUAGE_SET");
  if (t.conv.state === "IDLE") return menu(t, "MAIN_MENU");
  return resumePrompt(t);
}

/** Drop whatever was in progress (releasing a held slot) and show the menu. */
interface Ending { end: boolean; wrong: boolean; callSelf: boolean }

/** Messages that offered the main options (an "ok" after one of them gets a nudge, not the menu again). */
const MENUS = new Set(["MAIN_MENU", "OTHER_HELP", "OFF_TOPIC", "RUDE_REPLY", "HELP_REPLY", "STARTED_OVER", "LANGUAGE_SET"]);

/** Does the patient want to stop or leave, rather than ask for something? (A day, time, person or visit type means not.) */
async function wantsToEnd(t: Turn, e: Extraction, f: Ending): Promise<boolean> {
  const details = !!(e.date || e.time || e.partOfDay || e.phone || e.newPersonName || (e.relation && e.relation !== "SELF") || e.visitType);
  if (details) return false;
  if (f.callSelf || f.wrong) return true;
  const s = t.conv.state;
  // "I don't want to cancel" / "rehne do" while confirming a cancellation or deletion: keep everything.
  if ((s === "CX_CONFIRM" || s === "CX_PICK_APPT" || s === "ERASE_CONFIRM") && (f.end || e.intent === "END")) return true;
  // "I don't want my appointment" is a cancellation, and the other specific requests are answered as asked.
  if (["CANCEL", "RESCHEDULE", "DELETE_DATA", "MY_DATA", "STATUS", "MY_APPOINTMENTS", "CLINIC_INFO", "ARRIVED", "CHANGE_NUMBER", "CHANGE_LANGUAGE", "START", "TALK_TO_STAFF"].includes(e.intent)) return false;
  return e.intent === "END" || f.end;
}

/** The patient is done: drop what was in progress and say so in context (nothing booked / kept / nothing saved). */
async function endChat(t: Turn, f: Ending): Promise<void> {
  const s = t.conv.state;
  if (s === "CX_CONFIRM" || s === "CX_PICK_APPT") {
    const many = !!t.conv.cxIds?.length || s === "CX_PICK_APPT";
    t.conv.cxApptId = undefined; t.conv.cxIds = undefined; t.conv.cxList = undefined;
    t.set("IDLE");
    return t.text(many ? "CX_KEPT_MANY" : "CX_KEPT");
  }
  if (s === "ERASE_CONFIRM") { t.set("IDLE"); return t.text("ERASE_KEPT"); }
  const wasBooking = s.startsWith("BK_") || s === "RS_PICK_APPT" || !!t.conv.held;
  await dropFlow(t);
  if (f.callSelf) return callClinic(t);
  if (f.wrong) return t.text("WRONG_NUMBER");
  if (!(await hasConsent(t.ctx, t.acc.id))) return t.text("CLOSED_NO_CONSENT");
  const nameJi = t.nameJi(senderName(t));
  if (wasBooking) return t.text("BOOKING_STOPPED", { nameJi });
  await t.send({ kind: "text", body: t.tv("CHAT_CLOSED", { nameJi }) }, "CHAT_CLOSED");
}

/** "No" to the offered times or to the final confirmation: other times, or stop here (both one tap away). */
async function otherTimesOrStop(t: Turn): Promise<void> {
  return t.buttons(t.t("OTHER_TIMES_OR_STOP"), "OTHER_TIMES_OR_STOP", [{ id: "see_all", title: t.b("SHOW_FREE_TIMES") }, { id: "bk:stop", title: t.b("STOP_BOOKING") }]);
}

/** "Stop booking": release the held slot and confirm nothing was booked (no menu). */
async function stopBooking(t: Turn): Promise<void> {
  await dropFlow(t);
  return t.text("BOOKING_STOPPED", { nameJi: t.nameJi(senderName(t)) });
}

async function dropFlow(t: Turn): Promise<void> {
  if (t.conv.held) { await releaseHold(t.ctx, t.conv.held); t.conv.held = undefined; }
  t.conv.p = {};
  t.conv.offered = undefined;
  t.conv.requested = undefined;
  t.conv.raceLost = false;
  t.conv.misses = 0;
  t.set("IDLE");
}

async function stopFlow(t: Turn, id: "STARTED_OVER" | "MAIN_MENU"): Promise<void> {
  if (t.conv.held) { await releaseHold(t.ctx, t.conv.held); t.conv.held = undefined; }
  t.conv.p = {};
  t.conv.offered = undefined;
  t.conv.requested = undefined;
  t.conv.raceLost = false;
  t.set("IDLE");
  return menu(t, id);
}

/** "I want to book" in the middle of a booking: start that booking afresh. */
async function newBooking(t: Turn, e: Extraction | null): Promise<void> {
  if (t.conv.held) { await releaseHold(t.ctx, t.conv.held); t.conv.held = undefined; }
  t.conv.offered = undefined;
  t.conv.requested = undefined;
  t.conv.p = { intent: "BOOK" };
  t.set("IDLE");
  return e ? startBooking(t, e) : progressBooking(t);
}

/** "Hi" in the middle of something: say hello and ask whether to carry on. */
async function welcomeBack(t: Turn): Promise<void> {
  const name = currentName(t);
  const who = !name ? "" : t.lang === "en" ? ` for ${name} ji` : t.lang === "hi" ? ` ${name} जी के लिए` : ` ${name} ji ke liye`;
  return t.buttons(t.t("WELCOME_BACK_MIDFLOW", { who }), "WELCOME_BACK_MIDFLOW",
    [{ id: "resume:go", title: t.b("CONTINUE") }, { id: "resume:new", title: t.b("NEW_BOOKING") }, { id: "resume:menu", title: t.b("SOMETHING_ELSE") }]);
}

async function resumePrompt(t: Turn): Promise<void> {
  const s = t.conv.state;
  if (s === "BK_CONFIRM") return askConfirm(t);
  if (s === "BK_FLOW_OPEN" || s === "BK_WHO" || s === "BK_NAME") return progressBooking(t);
  if (s === "BK_PICK_SLOT" && t.conv.offered?.length) return t.buttons(t.t("RESUME_PROMPT", { pending: t.t("OFFER_NEXT_AVAILABLE") }), "RESUME_PROMPT", [...t.conv.offered.slice(0, 2).map(slotBtn), { id: "see_all", title: t.b("SEE_ALL") }]);
  if (s === "BK_WHEN") return t.conv.p.intent === "RESCHEDULE" ? askWhen(t) : t.text("RESUME_PROMPT", { pending: t.t("ASK_WHEN") });
  if (s === "BK_VISIT_TYPE") return askVisitType(t);
  return menu(t, "MAIN_MENU");
}

async function clinicInfoReply(t: Turn, topic: Extraction["clinicInfoTopic"]): Promise<void> {
  if (topic === "fees" && t.info.settings.fees) return t.text("CLINIC_FEES", { fees: t.info.settings.fees });
  if (topic === "address") return t.text("CLINIC_ADDRESS");
  await t.text("CLINIC_TIMINGS");
  if (topic !== "timings") await t.text("CLINIC_ADDRESS");
}

async function talkToStaff(t: Turn): Promise<void> {
  const name = currentName(t) ?? "Patient";
  const { maskPhone } = await import("@clinicq/db");
  t.ctx.bus.publish({ type: "callback.requested", name, maskedPhone: maskPhone(t.waId) });
  const staff = await t.ctx.db.staffUser.findMany({ where: { clinicId: t.info.clinic.id, active: true, onDuty: true } });
  for (const s of staff) await sendTo(t.ctx, decrypt(s.waPhone), { kind: "text", body: `${name} (${displayPhone(t.waId)}) asked for a call back.` }, { kind: "staff_callback" });
  return t.text("TALK_TO_STAFF");
}

async function myData(t: Turn): Promise<void> {
  const up = await upcomingForAccount(t.ctx, t.acc.id);
  const consent = await t.ctx.db.consentRecord.findFirst({ where: { accountId: t.acc.id }, orderBy: { givenAt: "desc" } });
  const lines = [
    `• WhatsApp: ${displayPhone(t.waId)}`,
    `• Profiles: ${t.profiles.map((p) => `${p.name} (${p.relation === "SELF" ? "you" : RELATION_LABEL[p.relation]?.en ?? "family"})${p.contactPhone ? `, contact ${displayPhone(p.contactPhone)}` : ""}`).join("; ") || "none"}`,
    `• Upcoming: ${up.map((u) => fmtAppt(t, u)).join("; ") || "none"}`,
    `• Consent: ${consent ? T.fmtDate(T.localDate(consent.givenAt, t.ctx.tz), "en") : "not given"}`,
  ];
  await t.ctx.db.dataRequest.create({ data: { accountHash: t.acc.phoneHash, type: "ACCESS", status: "DONE" } });
  return t.text("MY_DATA", { summary: lines.join("\n") });
}

async function erase(t: Turn): Promise<void> {
  const ctx = t.ctx;
  for (const u of await upcomingForAccount(ctx, t.acc.id)) await cancelAppointment(ctx, u.id, "PATIENT", t.acc.id);
  await ctx.db.appointment.updateMany({ where: { status: "HELD", profile: { accountId: t.acc.id } }, data: { status: "CANCELLED", slotKey: null } });
  await ctx.db.messageLog.updateMany({ where: { accountId: t.acc.id }, data: { accountId: null } });
  await ctx.db.dataRequest.create({ data: { accountHash: t.acc.phoneHash, type: "ERASURE", status: "DONE" } });
  await ctx.db.conversationState.deleteMany({ where: { accountId: t.acc.id } });
  await audit(ctx, "PATIENT", null, "data.erase", "PatientAccount", null);
  const lang = t.lang;
  const body = C.render("ERASE_DONE", lang, t.baseVars());
  await ctx.db.patientAccount.delete({ where: { id: t.acc.id } });
  // The erasure is complete; a failed confirmation (Meta outage, closed 24 h window) must not resurrect any state.
  await ctx.wa.send(t.waId, { kind: "text", body }).catch((e) => ctx.log.error({ err: e }, "erase_confirmation_not_sent"));
  // the account row is gone; saveConv would recreate it — mark so handleInbound skips persistence
  t.conv = { ...t.conv, state: "IDLE", p: {} };
  (t as unknown as { erased: boolean }).erased = true;
  throw new ErasedSignal();
}

export class ErasedSignal extends Error {}

function whenLabel(t: Turn, e: Extraction): string {
  const n = nowLocal(t.ctx);
  const parts = [];
  if (e.date) parts.push(T.fmtDayLabel(e.date, n.date, t.lang));
  if (e.partOfDay) parts.push(podLabel(t, e.partOfDay));
  if (e.time) parts.push(T.fmtTime(e.time));
  return parts.join(" ") || (t.lang === "en" ? "soon" : "jaldi");
}

export function slotAt(ctx: Ctx, date: string, min: number): Date { return slotInstant(ctx, { date, startMin: min }); }

// ── booking page (opened from WhatsApp) ────────────────────────

export type PageBookResult = { ok: true; apptId: string } | { ok: false; reason: "taken" | "family" | "unavailable" | "gone" };

/**
 * The patient confirmed a slot on the booking page. Runs through the same booking path as the chat (hold → confirm →
 * WhatsApp confirmation), in order with the patient's chat messages. The page itself showed the final confirmation.
 */
export async function bookFromPage(ctx: Ctx, accountId: string, profileId: string, ref: SlotRef, visitType: VisitType): Promise<PageBookResult> {
  const acc = await ctx.db.patientAccount.findUnique({ where: { id: accountId } });
  if (!acc) return { ok: false, reason: "gone" };
  const waId = decrypt(acc.waPhone);
  const { processSerially } = await import("../routes/webhook");
  let result: PageBookResult = { ok: false, reason: "unavailable" };
  await processSerially(waId, async () => {
    const info = await clinicInfo(ctx);
    const avail = await windowAvailability(ctx, info);
    const slot = S.findSlot(ref.date, ref.startMin, avail);
    if (!slot || S.bookability(slot, avail) !== "ok") { result = { ok: false, reason: slot && S.bookability(slot, avail) === "taken" ? "taken" : "unavailable" }; return; }
    const conv = await loadConv(ctx, acc);
    const t = new Turn(ctx, info, acc, waId, conv, await profilesOf(ctx, acc.id));
    if (t.conv.held) { await releaseHold(ctx, t.conv.held); t.conv.held = undefined; }
    try {
      const held = await holdSlot(ctx, slot, profileId, acc.id);
      t.conv.p = { intent: "BOOK", profileId, visitType };
      t.conv.held = held.id;
      t.conv.offered = [ref];
      await finalize(t);
      await saveConv(ctx, acc.id, t.conv);
      result = { ok: true, apptId: held.id };
    } catch (e) {
      if (e instanceof SlotTakenError) result = { ok: false, reason: "taken" };
      else if (e instanceof FamilySlotError) result = { ok: false, reason: "family" };
      else throw e;
    }
  });
  return result;
}
