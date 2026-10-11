import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { slots as S, time as T } from "@clinicq/core";
import { decrypt } from "@clinicq/db";
import type { Ctx } from "../context";
import { clinicInfo, windowAvailability } from "../services/clinic";
import { bookFromPage } from "../services/conversation";

// Booking page (form D) opened from a WhatsApp button: /book?t=<token>. The token (FlowToken row, 30 min, one use)
// names the patient account and profile; nothing else identifies the patient, and the page shows a first name only.

const VISITS = ["NEW", "FOLLOW_UP", "REPORT_SHOW"] as const;

export async function bookRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const load = async (token: string, reply: FastifyReply) => {
    const row = /^[A-Za-z0-9_-]{20,64}$/.test(token) ? await ctx.db.flowToken.findUnique({ where: { token } }) : null;
    if (!row || row.expiresAt < ctx.clock.now() || !row.profileId) { reply.code(410).send({ error: { code: "expired" } }); return null; }
    return row as typeof row & { profileId: string };
  };

  app.get("/api/book/:token", async (req, reply) => {
    const row = await load((req.params as { token: string }).token, reply); if (!row) return;
    const info = await clinicInfo(ctx);
    const [acc, profile] = await Promise.all([ctx.db.patientAccount.findUnique({ where: { id: row.accountId } }), ctx.db.patientProfile.findUnique({ where: { id: row.profileId } })]);
    const avail = await windowAvailability(ctx, info);
    const dates = S.flowDates(avail).map((d) => {
      const [dow, day, mon] = T.fmtDayShort(d.date, "en").split(" ");
      return { date: d.date, dow, day, mon, open: d.open, enabled: d.open && d.free > 0, free: d.free };
    });
    const vt = (await ctx.db.appointment.count({ where: { profileId: row.profileId, status: { in: ["COMPLETED", "BOOKED"] } } })) > 0 ? "FOLLOW_UP" : "NEW";
    return {
      clinic: { name: info.clinic.name, address: info.clinic.addressShort ?? "" },
      name: profile ? decrypt(profile.name).split(" ")[0] : "",
      lang: acc?.language ?? "en",
      waNumber: ctx.env.WA_DISPLAY_NUMBER,
      dates,
      selected: dates.find((d) => d.enabled)?.date ?? null,
      visitTypes: VISITS,
      suggestedVisit: vt,
      expiresAt: row.expiresAt,
    };
  });

  app.get("/api/book/:token/day/:date", async (req, reply) => {
    const { token, date } = req.params as { token: string; date: string };
    const row = await load(token, reply); if (!row) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return reply.code(400).send({ error: { code: "bad_date" } });
    return { date, sessions: daySessions(await windowAvailability(ctx, await clinicInfo(ctx)), date) };
  });

  app.post("/api/book/:token/confirm", async (req, reply) => {
    const row = await load((req.params as { token: string }).token, reply); if (!row) return;
    const b = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), min: z.number().int().min(0).max(1439), visitType: z.enum(VISITS) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: { code: "bad_request" } });
    const r = await bookFromPage(ctx, row.accountId, row.profileId, { date: b.data.date, startMin: b.data.min }, b.data.visitType);
    if (!r.ok) {
      const sessions = daySessions(await windowAvailability(ctx, await clinicInfo(ctx)), b.data.date);
      return reply.code(409).send({ error: { code: r.reason }, sessions });
    }
    await ctx.db.flowToken.delete({ where: { token: row.token } }).catch(() => undefined); // one use
    const appt = await ctx.db.appointment.findUniqueOrThrow({ where: { id: r.apptId } });
    return { ok: true, token: appt.token, date: b.data.date, time: T.fmtTime(b.data.min), visitType: b.data.visitType };
  });
}

/** One day's sessions with every slot: free ones selectable, booked ones greyed; past/too-soon ones left out. */
function daySessions(avail: Awaited<ReturnType<typeof windowAvailability>>, date: string) {
  const bySession = new Map<string, { label: string; slots: { min: number; time: string; free: boolean }[]; end: number }>();
  for (const s of S.allSlotsOn(date, avail)) {
    const why = S.bookability(s, avail);
    if (why === "past" || why === "cutoff" || why === "beyond_window") continue;
    const g = bySession.get(s.sessionId) ?? { label: s.sessionLabel, slots: [], end: 0 };
    g.slots.push({ min: s.startMin, time: T.fmtTime(s.startMin), free: why === "ok" });
    g.end = Math.max(g.end, s.endMin);
    bySession.set(s.sessionId, g);
  }
  return [...bySession.values()].map((g) => ({ label: g.label, hours: `${T.fmtTime(g.slots[0]!.min)} – ${T.fmtTime(g.end)}`, free: g.slots.filter((x) => x.free).length, slots: g.slots }));
}
