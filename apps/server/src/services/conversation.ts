import { randomBytes } from "node:crypto";
import { decrypt, displayPhone, encrypt, normalizeIndianPhone, phoneHash, type PatientAccount, type VisitType, type Relation } from "@clinicq/db";
import { copy as C, safety, slots as S, time as T } from "@clinicq/core";
import { extract, type Extraction, type ExtractContext } from "@clinicq/core/extract/index";
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
  | "BK_WHO" | "BK_NAME" | "BK_WHEN" | "BK_PICK_SLOT" | "BK_FLOW_OPEN" | "BK_VISIT_TYPE" | "BK_RACE_DECLINED" | "BK_SAME_FAMILY"
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
  welcomeSent?: boolean;
  emergencyAt?: number;
  lastOut?: string; // kind of the bot's last message (context for short replies like "sure", "ok")
  seed: number;
}

/** After these the conversation is complete; a bare "ok / sure / thanks" deserves a polite close, not a menu. */
const CLOSING = new Set(["BOOKING_CONFIRMED", "CX_DONE", "CX_KEPT", "RS_DONE", "REMINDER_CONFIRMED", "STATUS", "STATUS_BOOKED", "STATUS_NEXT", "STATUS_FUTURE",
  "THANKS_REPLY", "ACK_CLOSING", "MY_DATA", "MY_APPOINTMENTS", "CLINIC_ADDRESS", "CLINIC_FEES", "CLINIC_TIMINGS", "ALT_NUMBER_SAVED", "ARRIVED_OK", "ALREADY_IN_QUEUE",
  "LANGUAGE_SET", "OPTED_IN", "OPTED_OUT", "CALL_CLINIC", "YOUR_TURN"]);

const QUESTION: Partial<Record<State, string>> = {
  AWAIT_CONSENT: "agree to the privacy notice?", AWAIT_NUMBER_CONFIRM: "use this number for booking?", AWAIT_ALT_NUMBER: "10-digit mobile number",
  BK_WHO: "for you or someone else", BK_NAME: "the patient's name", BK_WHEN: "day and time", BK_PICK_SLOT: "choose a time",
  BK_VISIT_TYPE: "new consultation or follow-up", CX_CONFIRM: "cancel the appointment?", ERASE_CONFIRM: "delete your data?",
  WALKIN_ASK_NAME: "patient's name", BK_SAME_FAMILY: "book the next slot?", BK_RACE_DECLINED: "try another day or call the clinic?",
};

// ── turn helper ────────────────────────────────────────────────

class Turn {
  constructor(public ctx: Ctx, public info: ClinicInfo, public acc: PatientAccount, public waId: string, public conv: Conv, public profiles: ProfileView[]) {}
  get lang(): Lang { return this.conv.lang; }
  t(id: C.CopyId, vars: C.Vars = {}): string { return C.render(id, this.lang, { ...this.baseVars(), ...vars }, this.conv.seed); }
  b(id: C.BtnId, vars: C.Vars = {}): string { return C.btn(id, this.lang, vars); }
  baseVars(): C.Vars {
    const c = this.info.clinic;
    return { clinicName: c.name, clinicPhone: c.phone, noticeUrl: c.noticeUrl, addressShort: c.addressShort, address: c.addressFull, mapsLine: mapsLine(this.info), sessionHours: sessionHours(this.info), sessionsText: sessionsText(this.info), doctor: this.info.doctor.displayName };
  }
  nameJi(name?: string | null): string {
    if (!name) return "";
    return this.lang === "hi" ? `, ${name} जी` : `, ${name} ji`;
  }
  async send(msg: OutMsg, kind: string): Promise<void> {
    this.conv.lastOut = kind;
    await sendTo(this.ctx, this.waId, msg, { kind, accountId: this.acc.id });
  }
  async text(id: C.CopyId, vars: C.Vars = {}): Promise<void> { await this.send({ kind: "text", body: this.t(id, vars) }, id); }
  async buttons(body: string, kind: string, buttons: Button[]): Promise<void> {
    if (!buttons.length) return this.send({ kind: "text", body }, kind);
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
  if (row.expiresAt < ctx.clock.now()) return { ...fresh, lang: c.lang ?? acc.language, langLock: c.langLock, welcomeSent: c.welcomeSent };
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
    await route(t, msg);
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
    if (tr.kind !== "ok") return t.text(tr.kind === "too_long" ? "VOICE_TOO_LONG" : "VOICE_UNCLEAR");
    text = tr.text;
    isVoice = true;
  }
  if (!text.trim()) return menu(t, "OTHER_HELP");
  await onText(t, text, isVoice);
}

type VoiceResult = { kind: "ok"; text: string } | { kind: "unclear" } | { kind: "too_long" };

async function transcribeVoice(t: Turn, mediaId?: string): Promise<VoiceResult> {
  if (!mediaId) return { kind: "unclear" };
  let audio: Buffer | null = null;
  try {
    const m = await t.ctx.wa.downloadMedia(mediaId, 5 * 1024 * 1024);
    audio = m.data;
    for (const stt of await t.ctx.stt()) {
      try {
        const r = await stt.transcribe(audio, m.mime, 8000);
        if (r.text.split(/\s+/).filter(Boolean).length >= 2 && (r.confidence == null || r.confidence >= 0.6)) return { kind: "ok", text: r.text };
      } catch (e) { t.ctx.log.warn({ err: e, stt: stt.name }, "stt_failed"); }
    }
    return { kind: "unclear" };
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

  const out = await extract(text, extractCtx(t), await t.ctx.cascade());
  const meta = { intent: out.extraction.intent, source: out.source, escalated: out.escalated, reasons: out.reasons, calls: out.calls.map((c) => ({ spec: c.spec, ok: c.ok, ms: c.latencyMs, err: c.error })) };
  // Every configured model failed → we're running on the rules fallback; alert on this log line.
  if (out.source === "rules" && out.calls.length && out.calls.every((c) => !c.ok)) t.ctx.log.warn(meta, "ai_models_unavailable");
  else t.ctx.log.info(meta, "extracted");
  const e = out.extraction;
  if (e.possibleEmergency) return emergency(t);
  if (!t.conv.langLock) t.conv.lang = e.language;
  text = ""; // raw text is not needed beyond this point

  if (!(await gates(t, e))) return;

  const bookingish = ["BOOK", "PROVIDE", "RESCHEDULE", "AFFIRM", "DENY"].includes(e.intent) || t.conv.state.startsWith("BK_");
  if (e.hasNonBookingContent) {
    if (isVoice) await t.text("VOICE_UNDERSTOOD", { nameJi: t.nameJi(senderName(t)), when: whenLabel(t, e) });
    await t.send({ kind: "text", body: (isVoice ? t.t("HEALTH_NOT_SAVED") : t.t("HEALTH_DETAILS_REDIRECT", { nameJi: t.nameJi(senderName(t)) })) }, "HEALTH_DETAILS_REDIRECT");
    if (!bookingish && e.intent === "OTHER") return t.conv.state === "IDLE" ? menu(t, "OTHER_HELP") : resumePrompt(t);
  } else if (isVoice && ["BOOK", "PROVIDE"].includes(e.intent) && (e.date || e.time || e.partOfDay)) {
    await t.text("VOICE_UNDERSTOOD", { nameJi: t.nameJi(senderName(t)), when: whenLabel(t, e) });
  }

  // Global intents work from any state.
  switch (e.intent) {
    case "STATUS": return status(t);
    case "ARRIVED": return arrived(t);
    case "MY_APPOINTMENTS": return myAppointments(t);
    case "CLINIC_INFO": return clinicInfoReply(t, e.clinicInfoTopic);
    case "TALK_TO_STAFF": return talkToStaff(t);
    case "MY_DATA": return myData(t);
    case "DELETE_DATA": t.set("ERASE_CONFIRM"); return t.buttons(t.t("ERASE_CONFIRM"), "ERASE_CONFIRM", [{ id: "erase:yes", title: t.b("YES_DELETE") }, { id: "erase:no", title: t.b("KEEP_IT") }]);
    case "STOP": await t.ctx.db.patientAccount.update({ where: { id: t.acc.id }, data: { optedOutAt: t.ctx.clock.now() } }); return t.text("OPTED_OUT");
    case "START": await t.ctx.db.patientAccount.update({ where: { id: t.acc.id }, data: { optedOutAt: null } }); return t.text("OPTED_IN");
    case "CHANGE_LANGUAGE": t.conv.lang = e.language; t.conv.langLock = true; return t.text("LANGUAGE_SET");
    case "CHANGE_NUMBER": t.set("AWAIT_ALT_NUMBER"); return t.text("CHANGE_NUMBER_INFO");
    case "THANKS": if (t.conv.state === "IDLE" || !t.conv.state.startsWith("BK_")) return t.text("THANKS_REPLY"); break;
    case "CANCEL": if (t.conv.state !== "CX_CONFIRM" && t.conv.state !== "CX_PICK_APPT") return startCancel(t, e); break;
    case "RESCHEDULE": return startReschedule(t, e);
    default: break;
  }
  return onState(t, e);
}

async function onState(t: Turn, e: Extraction): Promise<void> {
  const s = t.conv.state;
  switch (s) {
    case "AWAIT_ALT_NUMBER": return altNumber(t, e);
    case "BK_WHO": return answerWho(t, e);
    case "BK_NAME": return answerName(t, e);
    case "BK_WHEN": return answerWhen(t, e);
    case "BK_PICK_SLOT": case "BK_FLOW_OPEN": return answerPick(t, e);
    case "BK_VISIT_TYPE":
      if (e.visitType) { t.conv.p.visitType = e.visitType; return finalize(t); }
      if (e.date || e.time != null) return answerPick(t, e);
      return askVisitType(t);
    case "BK_RACE_DECLINED":
      if (e.date || e.time != null || e.partOfDay) { mergeWhen(t, e); return offer(t); }
      if (e.intent === "AFFIRM") return askWhen(t);
      return callClinic(t);
    case "BK_SAME_FAMILY":
      if (e.intent === "AFFIRM" && t.conv.offered?.[0]) return choose(t, t.conv.offered[0]);
      if (e.intent === "DENY") return askWhen(t);
      return answerPick(t, e);
    case "CX_CONFIRM":
      if (e.intent === "AFFIRM" && t.conv.cxApptId) return doCancel(t, t.conv.cxApptId);
      if (e.intent === "DENY") { t.set("IDLE"); return t.text("CX_KEPT"); }
      return t.buttons(t.t("OTHER_HELP"), "CX_CONFIRM", cxButtons(t));
    case "ERASE_CONFIRM":
      if (e.intent === "AFFIRM") return erase(t);
      t.set("IDLE");
      return t.text("CX_KEPT");
    case "WALKIN_ASK_NAME": return walkinName(t, e);
    case "WI_AWAIT_STAFF": return t.text("WALKIN_CHECKING", { name: currentName(t) ?? "" });
    case "RS_PICK_APPT": case "CX_PICK_APPT": return s === "RS_PICK_APPT" ? startReschedule(t, e) : startCancel(t, e);
    default: break;
  }
  // IDLE
  if (e.intent === "BOOK" || (e.intent === "PROVIDE" && (e.date || e.time != null || e.partOfDay))) return startBooking(t, e);
  if (e.intent === "GREETING") return menu(t, "MAIN_MENU");
  if (e.intent === "AFFIRM" || e.intent === "DENY") return t.conv.lastOut && CLOSING.has(t.conv.lastOut) ? t.text("ACK_CLOSING") : menu(t, "OTHER_HELP");
  if (e.hasNonBookingContent) return;
  return menu(t, "OTHER_HELP");
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
        await t.buttons(t.t("CONSENT_REMINDER"), "CONSENT_REMINDER", [{ id: "consent:yes", title: t.b("AGREE") }]);
      }
      return false;
    }
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
    return askNumber(t);
  }
  return true;
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
  if (!(await gates(t, null))) return;
  switch (kind) {
    case "slot": {
      const [date, min] = (a ?? "").split("|");
      if (!date || !min) return askWhen(t);
      return choose(t, { date, startMin: Number(min) });
    }
    case "see_all": return slotPicker(t, t.conv.requested?.date ?? nowLocal(t.ctx).date);
    case "sess": { const [date, label] = (a ?? "").split("|"); return slotPicker(t, date ?? nowLocal(t.ctx).date, false, label); }
    case "vt": t.conv.p.visitType = a as VisitType; return finalize(t);
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
      if (a === "cx" && b) return askCancelConfirm(t, b);
      return myAppointments(t);
    case "cx": if (a === "yes" && b) return doCancel(t, b); t.set("IDLE"); return t.text("CX_KEPT");
    case "rs": return beginReschedule(t, a!, null);
    case "cxp": return askCancelConfirm(t, a!);
    case "erase": if (a === "yes") return erase(t); t.set("IDLE"); return t.text("CX_KEPT");
    case "race": return a === "another" ? askWhen(t) : callClinic(t);
    case "call": return callClinic(t);
    case "menu":
      if (a === "book") { t.conv.p = { intent: "BOOK", profileId: t.conv.p.profileId }; return progressBooking(t); }
      if (a === "status") return status(t);
      if (a === "appts") return myAppointments(t);
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
  return t.text(t.conv.p.intent === "RESCHEDULE" ? "RS_ASK_WHEN" : "ASK_WHEN");
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
    return t.text("ASK_WHEN");
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
  return !!(t.info.settings.flowsEnabled && t.ctx.env.WA_FLOW_ID_BOOKING && t.ctx.flowKey);
}

/** Form D: the WhatsApp booking form (date chips, Morning / Evening slot chips). */
async function openFlow(t: Turn): Promise<void> {
  const name = currentName(t) ?? "";
  const token = randomBytes(24).toString("base64url");
  await t.ctx.db.flowToken.create({ data: { token, accountId: t.acc.id, profileId: t.conv.p.profileId ?? null, expiresAt: new Date(t.ctx.clock.now().getTime() + 15 * 60_000) } });
  t.set("BK_FLOW_OPEN");
  return t.send({ kind: "flow", body: t.t("FLOW_BODY", { name }), cta: t.b("CHOOSE_DATE_TIME"), flowId: t.ctx.env.WA_FLOW_ID_BOOKING!, flowToken: token, screen: "PICK_DATE_SLOT", draft: t.ctx.env.WA_FLOW_MODE === "draft" }, "FLOW_BOOKING");
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
    return t.buttons(t.t("LIST_PICK_SESSION", { dayLabel }), "LIST_PICK_SESSION",
      [...bySession.entries()].slice(0, 3).map(([label, ss]) => ({ id: `sess:${day}|${label}`, title: `${label} (${ss.length})`.slice(0, 20) })));
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
  return t.send({ kind: "list", body: t.t("LIST_PICKER", { name }), button: t.b("VIEW_SLOTS"), sections }, "LIST_PICKER");
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
  if (e.intent === "DENY") return t.conv.raceLost ? raceDeclined(t, t.conv.requested?.time ?? null) : askWhen(t);
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
    if (t.conv.p.visitType || t.conv.p.intent === "RESCHEDULE") return finalize(t);
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
  return t.send({ kind: "list", body: t.t("RS_PICK_APPT"), button: t.b("MY_APPTS"), sections: [{ title: "Appointments", rows: up.slice(0, 10).map((u) => ({ id: `rs:${u.id}`, title: fmtAppt(t, u).slice(0, 24) })) }] }, "RS_PICK_APPT");
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

async function startCancel(t: Turn, e: Extraction | null): Promise<void> {
  const up = filterUpcoming(t, await upcomingForAccount(t.ctx, t.acc.id), e);
  if (!up.length) { t.set("IDLE"); return t.buttons(t.t("NO_UPCOMING"), "NO_UPCOMING", [{ id: "menu:book", title: t.b("BOOK") }]); }
  if (up.length === 1) return askCancelConfirm(t, up[0]!.id);
  t.set("CX_PICK_APPT");
  return t.send({ kind: "list", body: t.t("CX_PICK_APPT"), button: t.b("MY_APPTS"), sections: [{ title: "Appointments", rows: up.slice(0, 10).map((u) => ({ id: `cxp:${u.id}`, title: fmtAppt(t, u).slice(0, 24) })) }] }, "CX_PICK_APPT");
}

async function askCancelConfirm(t: Turn, apptId: string): Promise<void> {
  const a = await t.ctx.db.appointment.findUnique({ where: { id: apptId }, include: { profile: true } });
  if (!a || a.profile?.accountId !== t.acc.id || !["BOOKED", "ARRIVED"].includes(a.status)) return myAppointments(t);
  t.conv.cxApptId = a.id;
  t.set("CX_CONFIRM");
  return t.buttons(t.t("CX_CONFIRM", { name: firstName(decrypt(a.profile!.name)), dayShort: T.fmtDayShort(T.localDate(a.slotStart, t.ctx.tz), t.lang), time: T.fmtTime(T.localMinutes(a.slotStart, t.ctx.tz)) }), "CX_CONFIRM", cxButtons(t));
}

async function doCancel(t: Turn, apptId: string): Promise<void> {
  const a = await t.ctx.db.appointment.findUnique({ where: { id: apptId }, include: { profile: true } });
  if (!a || a.profile?.accountId !== t.acc.id) return myAppointments(t);
  if (["BOOKED", "ARRIVED", "HELD"].includes(a.status)) await cancelAppointment(t.ctx, apptId, "PATIENT", t.acc.id);
  t.conv.cxApptId = undefined;
  t.set("IDLE");
  return t.text("CX_DONE");
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

async function menu(t: Turn, id: "MAIN_MENU" | "OTHER_HELP"): Promise<void> {
  const name = t.profiles.find((p) => p.relation === "SELF")?.name ?? waName(t.acc);
  return t.buttons(t.t(id, { nameJi: t.nameJi(name ? firstName(name) : null) }), id, [
    { id: "menu:book", title: t.b("BOOK") }, { id: "menu:appts", title: t.b("MY_APPTS") }, { id: "menu:status", title: t.b("QUEUE_STATUS") },
  ]);
}

async function resumePrompt(t: Turn): Promise<void> {
  const s = t.conv.state;
  if (s === "BK_PICK_SLOT" && t.conv.offered?.length) return t.buttons(t.t("RESUME_PROMPT", { pending: t.t("OFFER_NEXT_AVAILABLE") }), "RESUME_PROMPT", [...t.conv.offered.slice(0, 2).map(slotBtn), { id: "see_all", title: t.b("SEE_ALL") }]);
  if (s === "BK_WHEN") return t.text("RESUME_PROMPT", { pending: t.t("ASK_WHEN") });
  if (s === "BK_VISIT_TYPE") return askVisitType(t);
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
