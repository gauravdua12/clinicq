import type { FastifyInstance } from "fastify";
import { slots as S, time as T } from "@clinicq/core";
import { decryptFlowRequest, encryptFlowResponse, FlowDecryptError, verifySignature, type EncryptedFlowRequest } from "@clinicq/wa";
import type { Ctx } from "../context";
import { FamilySlotError, holdSlot, SlotTakenError } from "../services/booking";
import { clinicInfo, nowLocal, windowAvailability } from "../services/clinic";

// WhatsApp Flow data endpoint for the booking form (docs/WHATSAPP_INTEGRATION.md §6.2).

export async function flowRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  app.post("/flow", { config: { rawBody: true } }, async (req, reply) => {
    if (!ctx.flowKey) return reply.code(503).send();
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
    const sig = req.headers["x-hub-signature-256"] as string | undefined;
    if (raw && sig && !verifySignature(raw, sig, ctx.env.META_APP_SECRET)) return reply.code(432).send();
    let dec;
    try { dec = decryptFlowRequest(req.body as EncryptedFlowRequest, ctx.flowKey); } catch (e) {
      if (e instanceof FlowDecryptError) return reply.code(421).send();
      throw e;
    }
    const res = await handleFlow(ctx, dec.payload);
    return reply.type("text/plain").send(encryptFlowResponse(res, dec.aesKey, dec.iv));
  });
}

interface FlowPayload { action?: string; screen?: string; data?: Record<string, unknown>; flow_token?: string; version?: string }

export async function handleFlow(ctx: Ctx, p: FlowPayload): Promise<Record<string, unknown>> {
  if (p.action === "ping") return { data: { status: "active" } };
  if (p.data && "error" in p.data) return { data: { acknowledged: true } };
  const token = p.flow_token ? await ctx.db.flowToken.findUnique({ where: { token: p.flow_token } }) : null;
  if (!token || token.expiresAt < ctx.clock.now()) return { screen: "PICK_DATE_SLOT", data: { ...EMPTY, error_message: "This booking link has expired. Please message us again." } };
  const info = await clinicInfo(ctx);
  const { decrypt } = await import("@clinicq/db");
  const profile = token.profileId ? await ctx.db.patientProfile.findUnique({ where: { id: token.profileId } }) : null;
  const who = profile ? decrypt(profile.name).split(" ")[0] : "";
  const intro = who ? `For ${who} ji · ${info.clinic.name}` : info.clinic.name;
  const screen = (avail: Awaited<ReturnType<typeof windowAvailability>>, date: string | null, error = "") => {
    const dates = S.flowDates(avail).map((d) => ({ id: d.date, title: T.fmtDayShort(d.date, "en").split(" ").slice(0, 2).join(" "), enabled: d.open && d.free > 0 }));
    const sel = date && dates.some((d) => d.id === date && d.enabled) ? date : (dates.find((d) => d.enabled)?.id ?? null);
    return { screen: "PICK_DATE_SLOT", data: { intro, dates, selected_date: sel ? [sel] : [], ...slotChips(avail, sel), error_message: error } };
  };
  const avail = await windowAvailability(ctx, info);
  const action = p.action === "data_exchange" ? String(p.data?.action ?? "") : p.action;
  if (action === "date_selected") return screen(avail, first(p.data?.date));
  if (action === "slot_selected") {
    const date = first(p.data?.date);
    const picked = [...asList(p.data?.morning), ...asList(p.data?.evening)];
    if (picked.length !== 1) return screen(avail, date, picked.length ? "Please choose just one time." : "Please choose a time.");
    const [d, min] = picked[0]!.split("|");
    const slot = d && min ? S.findSlot(d, Number(min), avail) : null;
    if (!slot || S.bookability(slot, avail) !== "ok" || !token.profileId) return screen(avail, d ?? date, "That time was just taken. Please pick another.");
    try {
      const held = await holdSlot(ctx, slot, token.profileId, token.accountId);
      return { screen: "CONFIRM", data: { slot: `${d}|${min}`, held: held.id, summary: `${who ? `${who} ji\n` : ""}${T.fmtDayShort(d!, "en")}, ${T.fmtTime(Number(min))}\n${info.clinic.name}` } };
    } catch (e) {
      if (e instanceof SlotTakenError || e instanceof FamilySlotError) return screen(await windowAvailability(ctx, info), d!, "That time was just taken. Please pick another.");
      throw e;
    }
  }
  return screen(avail, null); // INIT / navigate
}

const EMPTY = { intro: "", dates: [], selected_date: [], morning: [], evening: [], has_morning: false, has_evening: false, morning_label: "", evening_label: "" };
const first = (v: unknown): string | null => (Array.isArray(v) ? (v[0] != null ? String(v[0]) : null) : v ? String(v) : null);
const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : v ? [String(v)] : []);

/** Morning (sessions starting before 2 PM) and Evening chips for one day: booked slots greyed out, past ones hidden. */
function slotChips(avail: Awaited<ReturnType<typeof windowAvailability>>, date: string | null) {
  const all = date ? S.allSlotsOn(date, avail).filter((s) => !["past", "cutoff"].includes(S.bookability(s, avail))) : [];
  const group = (ss: typeof all, name: string) => {
    const label = ss.length ? `${name} · ${T.fmtTime(ss[0]!.startMin)} – ${T.fmtTime(ss[ss.length - 1]!.endMin)}` : name;
    return { chips: ss.map((s) => ({ id: `${s.date}|${s.startMin}`, title: T.fmtTime(s.startMin).replace(/ [AP]M$/, ""), enabled: S.bookability(s, avail) === "ok" })), label };
  };
  const m = group(all.filter((s) => s.startMin < 14 * 60), "Morning");
  const e = group(all.filter((s) => s.startMin >= 14 * 60), "Evening");
  return { morning: m.chips, evening: e.chips, has_morning: m.chips.length > 0, has_evening: e.chips.length > 0, morning_label: m.label, evening_label: e.label };
}
