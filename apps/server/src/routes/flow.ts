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
  if (!token || token.expiresAt < ctx.clock.now()) return { screen: "PICK_DATE_SLOT", data: { error_message: "This booking link has expired. Please message us again." } };
  const info = await clinicInfo(ctx);
  const avail = await windowAvailability(ctx, info);
  const n = nowLocal(ctx);
  const dates = S.flowDates(avail).map((d) => ({ id: d.date, title: T.fmtDayShort(d.date, "en"), enabled: d.open && d.free > 0 }));
  const slotsFor = (date: string) => S.freeSlotsOn(date, avail).map((s) => ({ id: `${s.date}|${s.startMin}`, title: T.fmtTime(s.startMin), description: s.sessionLabel }));
  const firstOpen = dates.find((d) => d.enabled)?.id ?? n.date;

  const action = p.action === "data_exchange" ? String(p.data?.action ?? "") : p.action;
  if (action === "INIT" || p.action === "INIT") {
    return { screen: "PICK_DATE_SLOT", data: { dates, selected_date: firstOpen, slots: slotsFor(firstOpen), has_slots: slotsFor(firstOpen).length > 0 } };
  }
  if (action === "date_selected") {
    const date = String(p.data?.date ?? firstOpen);
    const sl = slotsFor(date);
    return { screen: "PICK_DATE_SLOT", data: { dates, selected_date: date, slots: sl, has_slots: sl.length > 0 } };
  }
  if (action === "slot_selected") {
    const [date, min] = String(p.data?.slot ?? "").split("|");
    const slot = date && min ? S.findSlot(date, Number(min), avail) : null;
    if (!slot || S.bookability(slot, avail) !== "ok" || !token.profileId) {
      return { screen: "PICK_DATE_SLOT", data: { dates, selected_date: date ?? firstOpen, slots: slotsFor(date ?? firstOpen), has_slots: true, error_message: "That time was just taken. Please pick another." } };
    }
    try {
      const held = await holdSlot(ctx, slot, token.profileId, token.accountId);
      const profile = await ctx.db.patientProfile.findUnique({ where: { id: token.profileId } });
      const { decrypt } = await import("@clinicq/db");
      return { screen: "CONFIRM", data: { slot: `${date}|${min}`, held: held.id, summary: `${profile ? decrypt(profile.name).split(" ")[0] : ""}: ${T.fmtDayShort(date!, "en")}, ${T.fmtTime(Number(min))}\n${info.clinic.name}` } };
    } catch (e) {
      if (e instanceof SlotTakenError || e instanceof FamilySlotError) {
        const fresh = await windowAvailability(ctx, info);
        return { screen: "PICK_DATE_SLOT", data: { dates, selected_date: date, slots: S.freeSlotsOn(date!, fresh).map((s) => ({ id: `${s.date}|${s.startMin}`, title: T.fmtTime(s.startMin), description: s.sessionLabel })), has_slots: true, error_message: "That time was just taken. Please pick another." } };
      }
      throw e;
    }
  }
  return { screen: "PICK_DATE_SLOT", data: { dates, selected_date: firstOpen, slots: slotsFor(firstOpen), has_slots: true } };
}
