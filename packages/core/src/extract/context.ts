import type { Relation } from "./schema";
import { addDays, fmtTime, weekdayName } from "../time";

export interface SessionHint {
  weekday: number; // 0=Sun
  label: string;
  start: string; // "10:00"
  end: string; // "13:00"
}

export interface ProfileLabel {
  ref: string; // "P1" — opaque, never a name
  relation: Relation;
}

/** Minimal, non-identifying context sent along with a message (DATA_POLICY §8). */
export interface ExtractContext {
  today: string; // local "YYYY-MM-DD"
  nowTime: string; // local "HH:MM"
  sessions: SessionHint[];
  profiles: ProfileLabel[];
  state: string; // conversation state, e.g. "IDLE", "BK_WHEN"
  question?: string; // what the bot just asked, as a short description
  offeredTimes?: string[]; // "HH:MM" slots currently offered
}

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function sessionsText(sessions: SessionHint[]): string {
  const byLabel = new Map<string, { days: number[]; start: string; end: string }>();
  for (const s of sessions) {
    const key = `${s.label}|${s.start}|${s.end}`;
    const e = byLabel.get(key) ?? { days: [], start: s.start, end: s.end };
    e.days.push(s.weekday);
    byLabel.set(key, e);
  }
  const parts = [...byLabel.entries()].map(([k, v]) => {
    const days = [...new Set(v.days)].sort().map((d) => WD[d]).join(",");
    return `${k.split("|")[0]} ${v.start}–${v.end} (${days})`;
  });
  const open = new Set(sessions.map((s) => s.weekday));
  const closed = [0, 1, 2, 3, 4, 5, 6].filter((d) => !open.has(d)).map((d) => WD[d]);
  return parts.join("; ") + (closed.length ? `; closed ${closed.join(",")}` : "");
}

export function renderUserTurn(text: string, ctx: ExtractContext): string {
  const profiles = ctx.profiles.length
    ? ctx.profiles.map((p) => `${p.ref} relation=${p.relation}`).join("; ")
    : "none yet";
  const cal = Array.from({ length: 15 }, (_, i) => {
    const d = addDays(ctx.today, i);
    const tag = i === 0 ? " (today/aaj)" : i === 1 ? " (tomorrow/kal)" : i === 2 ? " (day after tomorrow/parso)" : "";
    return `${weekdayName(d).slice(0, 3)} ${d}${tag}`;
  }).join("; ");
  const lines = [
    `Today: ${weekdayName(ctx.today)} ${ctx.today} (Asia/Kolkata), now ${ctx.nowTime}.`,
    `Calendar (use it to resolve day names; a weekday name means its FIRST date in this list): ${cal}.`,
    `Clinic sessions: ${sessionsText(ctx.sessions)}.`,
    `Patient profiles on this number: ${profiles}.`,
    `Conversation state: ${ctx.state}${ctx.question ? ` (assistant asked: ${ctx.question})` : ""}.`,
  ];
  if (ctx.offeredTimes?.length) lines.push(`Times currently offered: ${ctx.offeredTimes.map((t) => `${t} (${fmtTime(t)})`).join(", ")}.`);
  lines.push(`Message: """${text.replace(/"""/g, '"')}"""`);
  return lines.join("\n");
}
