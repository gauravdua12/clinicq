import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildWebhook, MockWhatsApp, signBody, previewText } from "@clinicq/wa";
import type { Ctx } from "../context";
import { OffsetClock } from "../clock";

// Dev-only WhatsApp simulator backend (docs/WHATSAPP_INTEGRATION.md §7). Never registered in production.

export async function devRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const mock = ctx.sharedWa instanceof MockWhatsApp ? ctx.sharedWa : null;

  /** Build a Meta-format webhook, sign it, and post it through the real /webhook route. */
  app.post("/dev/simulate", async (req, reply) => {
    const b = req.body as { from: string; name?: string; phoneNumberId?: string; type: "text" | "button" | "voice" | "image" | "flow"; text?: string; buttonId?: string; buttonTitle?: string; voiceText?: string; audioBase64?: string; audioMime?: string; flow?: Record<string, unknown> };
    const wamid = `wamid.sim.${randomUUID()}`;
    let message: Record<string, unknown>;
    if (b.type === "button") message = { type: "interactive", interactive: { type: "button_reply", button_reply: { id: b.buttonId, title: b.buttonTitle ?? b.buttonId } } };
    else if (b.type === "voice") {
      const mediaId = `media.${randomUUID()}`;
      mock?.media.set(mediaId, b.audioBase64 ? { data: Buffer.from(b.audioBase64, "base64"), mime: b.audioMime ?? "audio/ogg; codecs=opus" } : { data: Buffer.from(b.voiceText ?? ""), mime: "audio/ogg; codecs=opus" });
      message = { type: "audio", audio: { id: mediaId, mime_type: "audio/ogg; codecs=opus", voice: true } };
    } else if (b.type === "image") message = { type: "image", image: { id: `media.${randomUUID()}`, mime_type: "image/jpeg" } };
    else if (b.type === "flow") message = { type: "interactive", interactive: { type: "nfm_reply", nfm_reply: { response_json: JSON.stringify(b.flow ?? {}), name: "flow" } } };
    else message = { type: "text", text: { body: b.text ?? "" } };
    const payload = JSON.stringify(buildWebhook({ from: b.from.replace(/\D/g, ""), name: b.name, wamid, message, phoneNumberId: b.phoneNumberId }));
    const res = await app.inject({ method: "POST", url: `${ctx.env.BASE_PATH}/webhook`, headers: { "content-type": "application/json", "x-hub-signature-256": signBody(payload, ctx.env.META_APP_SECRET) }, payload });
    return reply.code(res.statusCode).send({ wamid });
  });

  /** Outbound messages from the mock (simulator inbox). */
  app.get("/dev/outbox", async (req) => {
    const to = (req.query as { to?: string }).to?.replace(/\D/g, "");
    const since = Number((req.query as { since?: string }).since ?? 0);
    return (mock?.sent ?? []).filter((m) => (!to || m.to === to) && m.at > since).map((m) => ({ id: m.id, to: m.to, at: m.at, msg: m.msg, preview: previewText(m.msg) }));
  });

  app.post("/dev/clock", async (req) => {
    const b = req.body as { now?: string; offsetMinutes?: number };
    if (ctx.clock instanceof OffsetClock) {
      if (b.now) ctx.clock.offsetMs = new Date(b.now).getTime() - Date.now();
      else if (typeof b.offsetMinutes === "number") ctx.clock.offsetMs += b.offsetMinutes * 60_000;
      await ctx.jobs.runDue();
    } else if ("set" in ctx.clock && b.now) (ctx.clock as unknown as { set(d: string): void }).set(b.now);
    return { now: ctx.clock.now().toISOString() };
  });

  app.post("/dev/jobs/run", async () => ({ ran: await ctx.jobs.runDue() }));
}
