import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { encrypt, normalizeIndianPhone, phoneHash, type Clinic } from "@clinicq/db";
import { time as T } from "@clinicq/core";
import type { Ctx } from "../context";
import { clinicInfo, invalidateClinicCache } from "./clinic";
import { audit } from "./notify";

// Demo Studio: spin up a convincing demo clinic for a prospect from a name, website or brochure text.
// Uses PUBLIC business information only. Real onboarding is a separate, fuller process (docs/ONBOARDING.md).

export interface DemoInput {
  name: string;
  website?: string;
  details?: string; // pasted brochure / Google listing / prospectus text
  doctorName?: string;
  specialty?: string;
}

export interface ClinicProfile {
  clinicName: string;
  doctorName: string;
  qualification: string | null;
  specialty: string | null;
  addressShort: string;
  addressFull: string;
  phone: string | null;
  mapsUrl: string | null;
  fees: string | null;
  sessions: { days: number[]; label: string; start: string; end: string }[];
}

// ── safe public page fetch (no SSRF into private networks) ──

function privateIp(ip: string): boolean {
  if (ip.includes(":")) return /^(::1|fc|fd|fe80|::ffff:(10|127|192\.168|172\.(1[6-9]|2\d|3[01])|169\.254))/i.test(ip) || ip === "::";
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export async function fetchPublicText(raw: string, maxChars = 12000): Promise<string> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) throw new Error("bad_scheme");
  let url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  for (let hop = 0; hop < 4; hop++) {
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("bad_scheme");
    if (url.port && !["80", "443"].includes(url.port)) throw new Error("bad_port");
    const host = url.hostname;
    const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    if (!addrs.length || addrs.some((a) => privateIp(a.address))) throw new Error("private_address");
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(8000), headers: { "user-agent": "ClinicQ-DemoStudio/1.0", accept: "text/html,text/plain" } });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) { url = new URL(res.headers.get("location")!, url); continue; }
    if (!res.ok) throw new Error(`http_${res.status}`);
    const reader = res.body?.getReader();
    let html = "";
    if (reader) {
      const dec = new TextDecoder();
      for (let total = 0; total < 1_500_000;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        html += dec.decode(value, { stream: true });
      }
      await reader.cancel().catch(() => undefined);
    }
    return htmlToText(html).slice(0, maxChars);
  }
  throw new Error("too_many_redirects");
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>|<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(br|p|div|li|h\d|tr|section|footer|header)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

// ── profile extraction ──

const PROFILE_PROMPT = `You extract a clinic's PUBLIC business profile from website or brochure text for a demo setup.
Return ONLY a JSON object with keys:
{"clinicName":string,"doctorName":string,"qualification":string|null,"specialty":string|null,"addressShort":string,
"addressFull":string,"phone":string|null,"mapsUrl":string|null,"fees":string|null,
"sessions":[{"days":[1,2,3,4,5,6],"label":"Morning","start":"10:00","end":"13:00"}]}
Rules: days use 0=Sunday..6=Saturday; times 24h "HH:MM"; addressShort = locality + city (max 40 chars);
doctorName like "Dr. A. Sharma" (the main doctor; if several, the first); phone = the clinic's public contact number;
if timings are not stated, return an empty sessions array; never invent facts — use null when unknown.`;

const DEFAULT_SESSIONS: ClinicProfile["sessions"] = [
  { days: [1, 2, 3, 4, 5, 6], label: "Morning", start: "10:00", end: "13:00" },
  { days: [1, 2, 3, 4, 5, 6], label: "Evening", start: "17:00", end: "20:00" },
];

function cleanProfile(j: Record<string, unknown>, input: DemoInput): ClinicProfile {
  const str = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const sessions = Array.isArray(j.sessions)
    ? (j.sessions as Record<string, unknown>[]).map((s) => ({
        days: Array.isArray(s.days) ? (s.days as unknown[]).map(Number).filter((d) => d >= 0 && d <= 6) : [1, 2, 3, 4, 5, 6],
        label: str(s.label, 20) ?? (T.toMin(String(s.start ?? "10:00")) < 12 * 60 ? "Morning" : "Evening"),
        start: /^\d{2}:\d{2}$/.test(String(s.start)) ? String(s.start) : "",
        end: /^\d{2}:\d{2}$/.test(String(s.end)) ? String(s.end) : "",
      })).filter((s) => s.start && s.end && T.toMin(s.end) > T.toMin(s.start) && s.days.length)
    : [];
  const name = str(j.clinicName, 80) ?? input.name;
  return {
    clinicName: input.name.trim() || name,
    doctorName: input.doctorName?.trim() || str(j.doctorName, 60) || "Doctor",
    qualification: str(j.qualification, 100),
    specialty: input.specialty?.trim() || str(j.specialty, 60),
    addressShort: str(j.addressShort, 60) ?? "",
    addressFull: str(j.addressFull, 300) ?? str(j.addressShort, 60) ?? "",
    phone: str(j.phone, 20),
    mapsUrl: str(j.mapsUrl, 300)?.startsWith("http") ? str(j.mapsUrl, 300) : null,
    fees: str(j.fees, 80),
    sessions: sessions.length ? sessions : DEFAULT_SESSIONS,
  };
}

export async function extractProfile(ctx: Ctx, input: DemoInput): Promise<{ profile: ClinicProfile; sourceChars: number; usedModel: string | null; websiteError?: string }> {
  let text = "";
  let websiteError: string | undefined;
  if (input.website) {
    try { text += await fetchPublicText(input.website); } catch (e) { websiteError = (e as Error).message; }
  }
  if (input.details) text += `\n${input.details.slice(0, 8000)}`;
  const cascade = await ctx.cascade();
  const model = cascade.escalation ?? cascade.primary;
  if (!text.trim() || !model) return { profile: cleanProfile({}, input), sourceChars: text.length, usedModel: null, websiteError };
  try {
    const r = await model.call(PROFILE_PROMPT, `Clinic name given by the sales team: ${input.name}\n${input.specialty ? `Specialty: ${input.specialty}\n` : ""}Source text:\n"""${text}"""`, 20000);
    const j = (r.json && typeof r.json === "object" ? r.json : {}) as Record<string, unknown>;
    return { profile: cleanProfile(j, input), sourceChars: text.length, usedModel: model.spec, websiteError };
  } catch {
    return { profile: cleanProfile({}, input), sourceChars: text.length, usedModel: null, websiteError };
  }
}

// ── demo clinics ──

const DEMO_PATIENTS = ["Aarav Sharma", "Priya Nair", "Rohit Verma", "Sunita Devi", "Imran Khan", "Kavya Reddy", "Harpreet Kaur", "Vikram Joshi", "Neha Gupta", "Arjun Menon", "Fatima Shaikh", "Deepak Yadav"];

async function uniqueCode(ctx: Ctx, name: string): Promise<string> {
  const base = name.replace(/^(dr\.?\s*)/i, "").split(/\s+/).map((w) => w[0] ?? "").join("").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3) || "DMO";
  for (let i = 0; i < 50; i++) {
    const code = i ? `${base}${i}` : base;
    if (!(await ctx.db.clinic.findUnique({ where: { code } }))) return code;
  }
  return `D${randomBytes(3).toString("hex").toUpperCase()}`;
}

export function presenterPhones(): string[] {
  return (process.env.DEMO_PRESENTER_PHONES ?? "").split(",").map((p) => normalizeIndianPhone(p)).filter((p): p is string => !!p);
}

export async function createDemo(ctx: Ctx, input: DemoInput, actorId: string | null, profileOverride?: Partial<ClinicProfile>): Promise<{ clinic: Clinic; profile: ClinicProfile }> {
  const { profile: extracted } = profileOverride?.clinicName ? { profile: { ...cleanProfile({}, input), ...profileOverride } as ClinicProfile } : await extractProfile(ctx, input);
  const profile = { ...extracted, ...profileOverride } as ClinicProfile;
  const clinic = await ctx.db.clinic.create({
    data: {
      name: profile.clinicName, addressShort: profile.addressShort || "Demo address", addressFull: profile.addressFull || profile.addressShort || "Demo address",
      mapsUrl: profile.mapsUrl, phone: profile.phone ?? "+91 99203 23832", code: await uniqueCode(ctx, profile.clinicName),
      noticeUrl: `${ctx.env.PUBLIC_BASE_URL}${ctx.env.BASE_PATH}/privacy`, grievanceContact: { name: profile.doctorName, email: "", phone: profile.phone ?? "" },
      settings: { fees: profile.fees ?? "" }, displayKey: randomBytes(18).toString("base64url"),
      isDemo: true, demoSource: { website: input.website ?? null, specialty: profile.specialty, createdBy: actorId } as never,
    },
  });
  const doctor = await ctx.db.doctor.create({ data: { clinicId: clinic.id, displayName: profile.doctorName, qualification: profile.qualification } });
  for (const s of profile.sessions) for (const wd of [...new Set(s.days)]) {
    await ctx.db.session.create({ data: { doctorId: doctor.id, weekday: wd, label: s.label, startTime: s.start, endTime: s.end, slotMinutes: 15, walkinQuota: 8 } });
  }
  await audit(ctx, "OPERATOR", actorId, "demo.create", "Clinic", clinic.id, { name: clinic.name });
  await activateDemo(ctx, clinic.id, actorId);
  await seedDemoActivity(ctx, clinic.id);
  return { clinic, profile };
}

/** At boot (Demo Studio on): presenters are doctor-admins of whichever clinic is active, so they can always sign in. */
export async function ensurePresenters(ctx: Ctx): Promise<void> {
  const phones = presenterPhones();
  if (!phones.length) return;
  const { clinic } = await clinicInfo(ctx);
  for (const wa of phones) {
    await ctx.db.staffUser.upsert({
      where: { phoneHash: phoneHash(wa) },
      create: { clinicId: clinic.id, name: "Demo presenter", waPhone: encrypt(wa), phoneHash: phoneHash(wa), role: "DOCTOR" },
      update: { active: true },
    });
  }
}

/** Make a clinic the active one; demo presenters become its doctor-admin so they can run it from WhatsApp. */
export async function activateDemo(ctx: Ctx, clinicId: string, actorId: string | null): Promise<void> {
  await ctx.db.systemConfig.upsert({ where: { key: "activeClinicId" }, create: { key: "activeClinicId", value: clinicId as never, updatedBy: actorId }, update: { value: clinicId as never, updatedBy: actorId } });
  for (const wa of presenterPhones()) {
    await ctx.db.staffUser.upsert({
      where: { phoneHash: phoneHash(wa) },
      create: { clinicId, name: "Demo presenter", waPhone: encrypt(wa), phoneHash: phoneHash(wa), role: "DOCTOR" },
      update: { clinicId, active: true, onDuty: true },
    });
  }
  // Signed-in dashboard users follow the active clinic.
  if (actorId) await ctx.db.staffUser.updateMany({ where: { id: actorId }, data: { clinicId } });
  invalidateClinicCache();
  await audit(ctx, "OPERATOR", actorId, "demo.activate", "Clinic", clinicId);
}

/** Realistic, synthetic activity so the dashboard looks alive (no WhatsApp accounts, nothing is sent). */
export async function seedDemoActivity(ctx: Ctx, clinicId: string): Promise<void> {
  const doctor = await ctx.db.doctor.findFirstOrThrow({ where: { clinicId } });
  const sessions = await ctx.db.session.findMany({ where: { doctorId: doctor.id, active: true } });
  const now = ctx.clock.now();
  const today = T.localDate(now, ctx.tz);
  const nowMin = T.localMinutes(now, ctx.tz);
  let p = 0;
  const profile = async () => (await ctx.db.patientProfile.create({ data: { accountId: null, name: encrypt(DEMO_PATIENTS[p++ % DEMO_PATIENTS.length]!), relation: "SELF" } })).id;
  for (const day of [0, 1]) {
    const date = T.addDays(today, day);
    for (const s of sessions.filter((x) => x.weekday === T.weekdayOf(date))) {
      const start = T.toMin(s.startTime);
      const end = T.toMin(s.endTime);
      for (let m = start, i = 0; m + s.slotMinutes <= end && (!s.maxSlots || i < s.maxSlots); m += s.slotMinutes, i++) {
        if (i % 3 !== 1) continue; // about a third of slots booked
        if (day === 0 && m <= nowMin + 30) continue;
        const at = T.toInstant(date, m, ctx.tz);
        await ctx.db.appointment.create({ data: { doctorId: doctor.id, profileId: await profile(), sessionId: s.id, slotStart: at, slotKey: `${doctor.id}:${at.toISOString()}`, status: "BOOKED", visitType: i % 2 ? "NEW" : "FOLLOW_UP", token: `A-${i + 1}`, bookedAt: now, source: "WHATSAPP" } });
      }
    }
  }
  // Live queue if a session is running now.
  const cur = sessions.find((s) => s.weekday === T.weekdayOf(today) && nowMin >= T.toMin(s.startTime) - 30 && nowMin <= T.toMin(s.endTime));
  if (cur) {
    const mk = async (n: number, state: "COMPLETED" | "IN_CONSULT" | "NEXT" | "WAITING", minsAgo: number) => {
      const arrived = new Date(now.getTime() - minsAgo * 60_000);
      await ctx.db.queueEntry.create({ data: { doctorId: doctor.id, sessionId: cur.id, date: T.dateToDb(today), profileId: await profile(), source: "W", token: `W-${n}`, state, arrivedAt: arrived,
        promotedAt: state === "WAITING" ? null : arrived, consultStartedAt: state === "IN_CONSULT" ? new Date(now.getTime() - 4 * 60_000) : state === "COMPLETED" ? new Date(arrived.getTime() + 10 * 60_000) : null,
        completedAt: state === "COMPLETED" ? new Date(arrived.getTime() + 22 * 60_000) : null } });
    };
    await mk(1, "COMPLETED", 70); await mk(2, "COMPLETED", 55); await mk(3, "IN_CONSULT", 40); await mk(4, "NEXT", 30); await mk(5, "WAITING", 20); await mk(6, "WAITING", 8);
    await ctx.db.tokenCounter.upsert({ where: { doctorId_date_sessionId_series: { doctorId: doctor.id, date: T.dateToDb(today), sessionId: cur.id, series: "W" } }, create: { doctorId: doctor.id, date: T.dateToDb(today), sessionId: cur.id, series: "W", value: 6 }, update: { value: 6 } });
  }
  ctx.bus.publish({ type: "queue.updated", doctorId: doctor.id });
}

export async function resetDemo(ctx: Ctx, clinicId: string, actorId: string | null): Promise<void> {
  const doctor = await ctx.db.doctor.findFirstOrThrow({ where: { clinicId } });
  await ctx.db.queueEntry.deleteMany({ where: { doctorId: doctor.id } });
  await ctx.db.appointment.deleteMany({ where: { doctorId: doctor.id } });
  await ctx.db.walkinOverflowRequest.deleteMany({ where: { doctorId: doctor.id } });
  await ctx.db.tokenCounter.deleteMany({ where: { doctorId: doctor.id } });
  await ctx.db.closure.deleteMany({ where: { doctorId: doctor.id } });
  await ctx.db.doctor.update({ where: { id: doctor.id }, data: { delayMinutes: 0, pauseUntil: null } });
  // Prospects who chatted with the demo number: clear their conversation so the next demo starts fresh.
  await ctx.db.conversationState.deleteMany({});
  await ctx.db.patientProfile.deleteMany({ where: { accountId: null, appointments: { none: {} }, queueEntries: { none: {} } } });
  await seedDemoActivity(ctx, clinicId);
  await audit(ctx, "OPERATOR", actorId, "demo.reset", "Clinic", clinicId);
}

export async function deleteDemo(ctx: Ctx, clinicId: string, actorId: string | null): Promise<void> {
  const clinic = await ctx.db.clinic.findUniqueOrThrow({ where: { id: clinicId } });
  if (!clinic.isDemo) throw new Error("not_demo");
  const doctor = await ctx.db.doctor.findFirst({ where: { clinicId } });
  if (doctor) {
    await ctx.db.queueEntry.deleteMany({ where: { doctorId: doctor.id } });
    await ctx.db.appointment.deleteMany({ where: { doctorId: doctor.id } });
    await ctx.db.walkinOverflowRequest.deleteMany({ where: { doctorId: doctor.id } });
    await ctx.db.tokenCounter.deleteMany({ where: { doctorId: doctor.id } });
    await ctx.db.closure.deleteMany({ where: { doctorId: doctor.id } });
    await ctx.db.blockedSlot.deleteMany({ where: { doctorId: doctor.id } });
    await ctx.db.session.deleteMany({ where: { doctorId: doctor.id } });
    await ctx.db.doctor.delete({ where: { id: doctor.id } });
  }
  const home = await ctx.db.clinic.findFirst({ where: { id: { not: clinicId } }, orderBy: [{ isDemo: "asc" }, { createdAt: "asc" }] });
  if (home) {
    await ctx.db.staffUser.updateMany({ where: { clinicId }, data: { clinicId: home.id } });
    const active = await ctx.db.systemConfig.findUnique({ where: { key: "activeClinicId" } });
    if (active?.value === clinicId) await activateDemo(ctx, home.id, actorId);
  }
  await ctx.db.dailyWalkinCode.deleteMany({ where: { clinicId } });
  await ctx.db.clinic.delete({ where: { id: clinicId } });
  invalidateClinicCache();
  await audit(ctx, "OPERATOR", actorId, "demo.delete", "Clinic", clinicId);
}

