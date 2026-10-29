import type { FastifyInstance } from "fastify";
import { Prisma } from "@clinicq/db";
import { parseWebhook, verifySignature, type InboundMessage } from "@clinicq/wa";
import { copy, extract } from "@clinicq/core";
import type { Ctx } from "../context";
import { sendTo } from "../services/notify";
import { handleInbound, ErasedSignal } from "../services/conversation";
import { scopeForNumber } from "../services/tenancy";
import { currentChannel, inScope } from "../scope";

// WhatsApp webhook (docs/WHATSAPP_INTEGRATION.md §2). Messages are processed in memory, per sender in
// order; raw text never reaches the job queue or the database.

const chains = new Map<string, Promise<void>>();
const hitsByCtx = new WeakMap<Ctx, Map<string, number[]>>();

/** 20 inbound messages per minute per number (PRD security); beyond that we stay silent. */
function rateLimited(ctx: Ctx, from: string, now: number): boolean {
  let hits = hitsByCtx.get(ctx);
  if (!hits) { hits = new Map(); hitsByCtx.set(ctx, hits); }
  const xs = (hits.get(from) ?? []).filter((t) => now - t < 60_000);
  xs.push(now);
  hits.set(from, xs);
  return xs.length > 20;
}

const staleNotified = new WeakMap<Ctx, Map<string, number>>();

/**
 * Meta re-delivers messages for days if the server was down or switched off (demo server is time-shared).
 * Acting on an old "book me tomorrow" would be wrong, so old messages get one "please send again" (only possible
 * inside the 24 h window) and are otherwise ignored. Only real Meta traffic: mock mode runs on fake clocks.
 */
async function staleRedelivery(ctx: Ctx, msg: InboundMessage): Promise<boolean> {
  if (ctx.env.WA_MODE !== "cloud" || !msg.timestamp) return false;
  const now = ctx.clock.now().getTime();
  const ageMs = now - msg.timestamp * 1000;
  if (ageMs <= ctx.env.STALE_INBOUND_MIN * 60_000) return false;
  ctx.log.warn({ kind: msg.kind, ageMin: Math.round(ageMs / 60_000) }, "stale_inbound_skipped");
  let seen = staleNotified.get(ctx);
  if (!seen) { seen = new Map(); staleNotified.set(ctx, seen); }
  if (ageMs < 23.5 * 3600_000 && now - (seen.get(msg.from) ?? 0) > 3600_000) {
    seen.set(msg.from, now);
    const lang = msg.kind === "text" && msg.text ? extract.detectLanguage(msg.text) : "en";
    await sendTo(ctx, msg.from, { kind: "text", body: copy.render("STALE_MESSAGE", lang) }, { kind: "stale_message" });
  }
  return true;
}

export function processSerially(from: string, fn: () => Promise<void>): Promise<void> {
  const prev = chains.get(from) ?? Promise.resolve();
  const next = prev.then(fn, fn).finally(() => { if (chains.get(from) === next) chains.delete(from); });
  chains.set(from, next);
  return next;
}

export async function ingest(ctx: Ctx, msg: InboundMessage): Promise<boolean> {
  // Which clinic's number it was sent to (src/scope.ts); a disconnected clinic's number is no longer ours to answer.
  const scope = await scopeForNumber(ctx, msg.phoneNumberId);
  if (scope === "ignore") { ctx.log.warn({ kind: msg.kind }, "inbound_for_disconnected_number"); return false; }
  return inScope(scope, () => ingestScoped(ctx, msg));
}

async function ingestScoped(ctx: Ctx, msg: InboundMessage): Promise<boolean> {
  try {
    await ctx.db.processedMessage.create({ data: { wamid: msg.wamid } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return false; // duplicate delivery
    throw e;
  }
  if (rateLimited(ctx, msg.from, ctx.clock.now().getTime())) { ctx.log.warn({ kind: msg.kind }, "rate_limited"); return false; }
  if (await staleRedelivery(ctx, msg)) return false;
  await processSerially(`${currentChannel()}:${msg.from}`, async () => {
    try { await handleInbound(ctx, msg); } catch (e) { if (!(e instanceof ErasedSignal)) ctx.log.error({ err: e }, "inbound_failed"); }
  });
  return true;
}

export async function webhookRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  app.get("/webhook", async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === ctx.env.META_VERIFY_TOKEN) return reply.type("text/plain").send(q["hub.challenge"] ?? "");
    return reply.code(403).send();
  });

  app.post("/webhook", { config: { rawBody: true } }, async (req, reply) => {
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!raw || !verifySignature(raw, req.headers["x-hub-signature-256"] as string | undefined, ctx.env.META_APP_SECRET)) return reply.code(401).send();
    const { messages, statuses } = parseWebhook(JSON.parse(raw.toString("utf8")));
    for (const s of statuses) {
      await ctx.db.messageLog.updateMany({ where: { wamid: s.wamid }, data: { status: s.status, errorCode: s.errorCode ?? null } }).catch(() => undefined);
    }
    // Answer Meta quickly; keep a bounded wait so tests (and short replies) stay deterministic.
    const work = Promise.all(messages.map((m) => ingest(ctx, m)));
    await Promise.race([work, new Promise((r) => setTimeout(r, 9000))]);
    return reply.code(200).send();
  });
}
