import { decrypt, normalizeIndianPhone, type StaffUser } from "@clinicq/db";
import { extract as X, time as T } from "@clinicq/core";
import type { InboundMessage } from "@clinicq/wa";
import type { Ctx } from "../context";
import { presenterPhones } from "./demo";
import { isAdminPhone } from "./admins";
import { clinicInfo, currentSession, nowLocal } from "./clinic";
import { applyClosure } from "./closures";
import { sendTo } from "./notify";
import { advance, issueWalkin, markNoShow, setDelay, setPause, snapshot, startNext, type QueueSnapshot } from "./queue";
import { decideOverflow } from "./walkin";

// Doctor/staff WhatsApp commands (docs/CONVERSATION_GUIDE.md §8). Returns true when handled.

interface StaffConv { state: "IDLE" | "OVF_TIME" | "CLOSE_CONFIRM"; requestId?: string }

const HELP = [
  "Commands:",
  "NEXT / DONE: consultation completed, call next",
  "START: start consultation for Next",
  "SKIP: mark Next as no-show",
  "STATUS: queue snapshot",
  "ADD <name> [phone]: add walk-in",
  "LATE <min> · PAUSE <min> · RESUME",
  "CLOSE TODAY: cancel the rest of today",
  "SUMMARY: today's numbers",
].join("\n");
const PRESENTER_HELP = [
  "Demo presenter: plain messages go to the patient side. Desk commands start with #:",
  ...HELP.split("\n").slice(1).map((l) => `#${l}`),
].join("\n");

async function isPresenter(ctx: Ctx, waId: string): Promise<boolean> {
  return presenterPhones().includes(waId) || (await isAdminPhone(ctx, waId));
}

async function load(ctx: Ctx, staffId: string): Promise<StaffConv> {
  const row = await ctx.db.conversationState.findUnique({ where: { accountId: `staff:${staffId}` } });
  if (!row || row.expiresAt < ctx.clock.now()) return { state: "IDLE" };
  return { state: row.state as StaffConv["state"], ...(row.context as object) };
}
async function save(ctx: Ctx, staffId: string, c: StaffConv): Promise<void> {
  const { state, ...rest } = c;
  const expiresAt = new Date(ctx.clock.now().getTime() + 15 * 60_000);
  await ctx.db.conversationState.upsert({ where: { accountId: `staff:${staffId}` }, create: { accountId: `staff:${staffId}`, state, context: rest as never, expiresAt }, update: { state, context: rest as never, expiresAt } });
}

export function snapshotText(s: QueueSnapshot, prefix = ""): string {
  if (!s.session) return `${prefix}No session running right now.`;
  const lines = [
    prefix + `${s.session.label} session`,
    `In consultation: ${s.inConsult ? `${s.inConsult.token} ${s.inConsult.name}` : "—"}`,
    `Next: ${s.next ? `${s.next.token} ${s.next.name}` : "—"}`,
    `Waiting: ${s.waiting.length}${s.waiting.length ? ` (${s.waiting.slice(0, 4).map((w) => w.token).join(", ")}${s.waiting.length > 4 ? "…" : ""})` : ""}`,
  ];
  if (s.delayMin) lines.push(`Running ${s.delayMin} min late`);
  return lines.join("\n");
}

export async function handleStaffMessage(ctx: Ctx, staff: StaffUser, msg: InboundMessage): Promise<boolean> {
  const waId = msg.from;
  const actor = { type: staff.role, id: staff.id };
  const reply = (body: string, buttons?: { id: string; title: string }[]) =>
    sendTo(ctx, waId, buttons?.length ? { kind: "buttons", body, buttons } : { kind: "text", body }, { kind: "staff_reply" });
  const conv = await load(ctx, staff.id);

  // Overflow buttons: ovf:<id>:yes|no|end|t:HH:MM
  if (msg.kind === "button" && msg.buttonId?.startsWith("ovf:")) {
    const [, id, action, hhmm] = msg.buttonId.split(":");
    if (!id) return true;
    if (action === "yes") {
      const req = await ctx.db.walkinOverflowRequest.findUnique({ where: { id } });
      if (!req || req.status !== "PENDING") { await reply(await handledText(ctx, id)); return true; }
      await save(ctx, staff.id, { state: "OVF_TIME", requestId: id });
      const snap = await snapshot(ctx);
      const suggest = T.fmtTime(Math.ceil((nowLocal(ctx).min + (snap.waiting.length + 1) * (snap.avgConsultMin || 10)) / 10) * 10);
      await reply("Which time should I give? Type a time (e.g. 7:40 PM) or choose:", [{ id: `ovf:${id}:end`, title: "End of queue" }, { id: `ovf:${id}:t:${T.fromMin(T.toMin(suggestToHHMM(suggest)))}`, title: suggest }]);
      return true;
    }
    const d = action === "no" ? { decision: "no" as const } : action === "end" ? { decision: "yes" as const, endOfQueue: true } : { decision: "yes" as const, time: hhmm ? T.toInstant(nowLocal(ctx).date, `${hhmm}:${msg.buttonId.split(":")[4] ?? "00"}`, ctx.tz) : null };
    const r = await decideOverflow(ctx, id, d, { id: staff.id, name: staff.name });
    await save(ctx, staff.id, { state: "IDLE" });
    await reply(r.ok ? (d.decision === "no" ? "Okay. The patient has been offered booking slots." : "Done. The patient has been given a token.") : await handledText(ctx, id));
    if (r.ok) await notifyOtherStaff(ctx, staff, `Walk-in request handled by ${staff.name}.`);
    return true;
  }

  let text = (msg.text ?? msg.buttonTitle ?? "").trim();
  // Demo presenters are doctor and patient on one phone: plain messages go to the patient side, desk commands
  // carry a "#" (or "/") prefix. Pending staff questions (overflow time, close-today confirm) still come here.
  if ((await isPresenter(ctx, waId)) && conv.state === "IDLE") {
    if (!/^[#/]/.test(text)) return false;
    text = text.replace(/^[#/]\s*/, "");
    if (!text || /^(help|commands?)$/i.test(text)) { await reply(PRESENTER_HELP); return true; }
  }
  if (!text) { await reply(HELP); return true; }
  const lower = text.toLowerCase();

  if (conv.state === "OVF_TIME" && conv.requestId) {
    const info = await clinicInfo(ctx);
    const n = nowLocal(ctx);
    const tm = X.parseTime(lower, { today: n.date, nowTime: n.time, sessions: info.sessions.map((s) => ({ weekday: s.weekday, label: s.label, start: s.startTime, end: s.endTime })), profiles: [], state: "WALKIN_STAFF_TIME" });
    const end = /end|last|baad/.test(lower);
    if (!tm.time && !end) { await reply("Please type a time like 7:40 PM, or reply END for end of queue."); return true; }
    const r = await decideOverflow(ctx, conv.requestId, { decision: "yes", time: tm.time ? T.toInstant(n.date, tm.time, ctx.tz) : null, endOfQueue: end }, { id: staff.id, name: staff.name });
    await save(ctx, staff.id, { state: "IDLE" });
    await reply(r.ok ? `Done. Token issued${tm.time ? ` for around ${T.fmtTime(tm.time)}` : ""}.` : await handledText(ctx, conv.requestId));
    if (r.ok) await notifyOtherStaff(ctx, staff, `Walk-in request handled by ${staff.name}.`);
    return true;
  }

  if (conv.state === "CLOSE_CONFIRM") {
    await save(ctx, staff.id, { state: "IDLE" });
    if (/^(yes|y|haan|confirm)\b/.test(lower)) {
      const n = await applyClosure(ctx, { date: nowLocal(ctx).date, sessionId: null, label: "Closed today", actorId: staff.id });
      await reply(`Clinic closed for today. ${n} patient(s) informed and offered new times.`);
    } else await reply("Okay, nothing was cancelled.");
    return true;
  }

  const num = (s: string) => Number(s.match(/\d+/)?.[0] ?? NaN);
  if (/^(next|done|agla|completed?)\b/.test(lower)) { const s = await advance(ctx, actor); await reply(snapshotText(s, "✅ ")); return true; }
  if (/^start\b/.test(lower)) { const s = await startNext(ctx, actor); await reply(snapshotText(s)); return true; }
  if (/^(skip|noshow|no-show|no show)\b/.test(lower)) {
    const s0 = await snapshot(ctx);
    if (!s0.next) { await reply("Nobody is in Next."); return true; }
    const s = await markNoShow(ctx, s0.next.id, actor);
    await reply(snapshotText(s, `${s0.next.token} marked no-show.\n`));
    return true;
  }
  if (/^(status|queue)\b/.test(lower)) { await reply(snapshotText(await snapshot(ctx))); return true; }
  if (/^late\b/.test(lower)) {
    const m = num(lower);
    if (Number.isNaN(m)) { await reply("Use LATE <minutes>, e.g. LATE 20"); return true; }
    const informed = await setDelay(ctx, m, actor);
    await reply(`Running ${m} min late. Informed ${informed} patient(s).`);
    return true;
  }
  if (/^pause\b/.test(lower)) { const m = num(lower) || 15; const n = await setPause(ctx, m, actor); await reply(`Break for ${m} min. Informed ${n} waiting patient(s).`); return true; }
  if (/^resume\b/.test(lower)) { await setPause(ctx, 0, actor); await reply("Resumed."); return true; }
  if (/^close today\b/.test(lower)) {
    const info = await clinicInfo(ctx);
    const n = nowLocal(ctx);
    const remaining = await ctx.db.appointment.count({ where: { doctorId: info.doctor.id, status: "BOOKED", slotStart: { gte: ctx.clock.now(), lt: T.toInstant(T.addDays(n.date, 1), "00:00", ctx.tz) } } });
    const waiting = (await snapshot(ctx)).waiting.length;
    await save(ctx, staff.id, { state: "CLOSE_CONFIRM" });
    await reply(`Cancel the remaining ${remaining} appointment(s) and ${waiting} waiting? Reply YES to confirm.`);
    return true;
  }
  if (/^add\b/.test(lower)) {
    const rest = text.slice(3).trim();
    const phone = rest.match(/(\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}/)?.[0];
    const name = rest.replace(phone ?? "", "").trim();
    if (!name) { await reply("Use ADD <name> [phone]"); return true; }
    const info = await clinicInfo(ctx);
    const cur = currentSession(ctx, info);
    if (!cur) { await reply("No session running right now."); return true; }
    let profileId: string | null = null;
    if (phone) {
      const wa = normalizeIndianPhone(phone);
      if (wa) {
        const { findOrCreateAccount, createProfile } = await import("./patients");
        const acc = await findOrCreateAccount(ctx, wa);
        await ctx.db.patientAccount.update({ where: { id: acc.id }, data: { lastInboundAt: null } });
        profileId = (await createProfile(ctx, acc.id, name, "SELF")).id;
      }
    }
    const e = await issueWalkin(ctx, { sessionId: cur.session.id, date: cur.date, profileId, displayName: profileId ? null : name, actor });
    const s = await snapshot(ctx);
    await reply(`Added ${e.token} ${name}. ${s.waiting.length} waiting.`);
    return true;
  }
  if (/^summary\b/.test(lower)) {
    const s = await snapshot(ctx);
    await reply(`Today: ${s.counts.booked} booked · ${s.counts.walkins} walk-ins · ${s.counts.completed} completed · ${s.counts.noShow} no-show · ${s.counts.waiting} waiting · avg consult ${s.avgConsultMin} min`);
    return true;
  }
  await reply(HELP);
  return true;
}

function suggestToHHMM(label: string): string {
  const m = label.match(/(\d+):(\d+) (AM|PM)/);
  if (!m) return "00:00";
  let h = Number(m[1]) % 12;
  if (m[3] === "PM") h += 12;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

async function handledText(ctx: Ctx, requestId: string): Promise<string> {
  const req = await ctx.db.walkinOverflowRequest.findUnique({ where: { id: requestId } });
  if (!req) return "This request no longer exists.";
  if (req.status === "TIMED_OUT") return "Already handled (no reply in time, so the patient was offered booking slots).";
  const by = req.decidedById ? await ctx.db.staffUser.findUnique({ where: { id: req.decidedById } }) : null;
  return `Already handled by ${by?.name ?? "another staff member"}.`;
}

async function notifyOtherStaff(ctx: Ctx, staff: StaffUser, body: string): Promise<void> {
  const others = await ctx.db.staffUser.findMany({ where: { clinicId: staff.clinicId, active: true, onDuty: true, id: { not: staff.id } } });
  for (const o of others) await sendTo(ctx, decrypt(o.waPhone), { kind: "text", body }, { kind: "staff_handled" });
}
