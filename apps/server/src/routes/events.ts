import type { FastifyInstance, FastifyReply } from "fastify";
import type { Ctx } from "../context";
import { clinicInfo } from "../services/clinic";
import type { BusEvent } from "../sse";
import { requireStaff } from "./auth";

// Server-Sent Events for dashboards (all events) and the TV display (queue/doctor status only).

function stream(ctx: Ctx, reply: FastifyReply, filter: (e: BusEvent) => boolean): void {
  reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  reply.raw.write(": connected\n\n");
  let id = 0;
  const off = ctx.bus.subscribe((e) => { if (filter(e)) reply.raw.write(`id: ${++id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); });
  const hb = setInterval(() => reply.raw.write(": hb\n\n"), 25_000);
  reply.raw.on("close", () => { off(); clearInterval(hb); });
}

export async function eventRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  app.get("/api/events", async (req, reply) => {
    if (!(await requireStaff(ctx, req, reply))) return;
    stream(ctx, reply, () => true);
    return reply;
  });
  app.get("/api/display/events", async (req, reply) => {
    const info = await clinicInfo(ctx);
    if ((req.query as { key?: string }).key !== info.clinic.displayKey) return reply.code(401).send();
    stream(ctx, reply, (e) => e.type === "queue.updated" || e.type === "doctor.status");
    return reply;
  });
}
