import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { createDb, initCrypto, type Db } from "@clinicq/db";
import { createLogger, type Logger } from "@clinicq/core";
import { CloudApiClient, loadPrivateKey, MockWhatsApp, type WhatsAppClient } from "@clinicq/wa";
import { MockSpeechToText } from "@clinicq/ai/stt";
import { OffsetClock, type Clock } from "./clock";
import type { Ctx } from "./context";
import type { Env } from "./env";
import { registerJobs } from "./jobs/handlers";
import { Scheduler } from "./jobs/scheduler";
import { apiRoutes } from "./routes/api";
import { authRoutes } from "./routes/auth";
import { devRoutes } from "./routes/dev";
import { eventRoutes } from "./routes/events";
import { flowRoutes } from "./routes/flow";
import { webhookRoutes } from "./routes/webhook";
import { AiRuntime } from "./services/ai";
import { EventBus } from "./sse";

export interface BuildOpts { env: Env; db?: Db; wa?: WhatsAppClient; clock?: Clock; log?: Logger; serveStatic?: boolean }

export async function buildApp(opts: BuildOpts): Promise<{ app: FastifyInstance; ctx: Ctx; ai: AiRuntime }> {
  const env = opts.env;
  initCrypto({ dataKeyB64: env.DATA_KEY, pepperB64: env.HASH_PEPPER });
  const db = opts.db ?? createDb(env.DATABASE_URL);
  const log = opts.log ?? createLogger({ level: env.NODE_ENV === "test" ? "silent" : undefined });
  const clock = opts.clock ?? new OffsetClock();
  const wa = opts.wa ?? (env.WA_MODE === "cloud"
    ? new CloudApiClient({ token: env.WA_ACCESS_TOKEN ?? "", phoneNumberId: env.WA_PHONE_NUMBER_ID ?? "", graphVersion: env.WA_GRAPH_VERSION })
    : new MockWhatsApp());
  const ai = new AiRuntime(db, env, new MockSpeechToText());
  const flowKey = env.FLOW_PRIVATE_KEY_PATH && existsSync(env.FLOW_PRIVATE_KEY_PATH) ? loadPrivateKey(readFileSync(env.FLOW_PRIVATE_KEY_PATH, "utf8"), env.FLOW_PRIVATE_KEY_PASSPHRASE) : null;
  const ctx: Ctx = {
    env, db, wa, log, clock, bus: new EventBus(), tz: env.CLINIC_TZ,
    jobs: new Scheduler(db, clock, log),
    cascade: () => ai.cascade(),
    stt: () => ai.stt(),
    flowKey,
  };
  registerJobs(ctx);

  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, trustProxy: true });
  // Keep the raw body for signature verification on /webhook and /flow.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
    try { done(null, (body as Buffer).length ? JSON.parse((body as Buffer).toString("utf8")) : {}); } catch { done(Object.assign(new Error("invalid_json"), { statusCode: 400 }), undefined); }
  });
  await app.register(cookie, { secret: env.SESSION_SECRET });
  if (env.WEB_DEV_ORIGIN && env.NODE_ENV !== "production") await app.register(cors, { origin: env.WEB_DEV_ORIGIN, credentials: true });
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-frame-options", "DENY");
    return payload;
  });

  const base = env.BASE_PATH;
  await app.register(async (scope) => {
    scope.get("/healthz", async () => {
      let dbOk = true;
      try { await db.$queryRaw`SELECT 1`; } catch { dbOk = false; }
      return { ok: dbOk, db: dbOk };
    });
    scope.get("/privacy", async (_req, reply) => reply.type("text/html").send(privacyHtml()));

    await webhookRoutes(scope, ctx);
    await flowRoutes(scope, ctx);
    await authRoutes(scope, ctx);
    await apiRoutes(scope, ctx, ai);
    await eventRoutes(scope, ctx);
    if (env.DEV_TOOLS && env.NODE_ENV !== "production") await devRoutes(scope, ctx);

    if (opts.serveStatic !== false) {
      const here = dirname(fileURLToPath(import.meta.url));
      const webOut = [join(here, "../../web/out"), join(here, "../public"), join(process.cwd(), "apps/web/out")].find((p) => existsSync(p));
      if (webOut) {
        await scope.register(fastifyStatic, { root: webOut, wildcard: false, index: false });
        // Clean URLs: /login → login.html (Next static export), assets served as-is.
        scope.get("/*", (req, reply) => {
          const rel = req.url.split("?")[0]!.slice(base.length);
          const path = decodeURIComponent(rel.replace(/\/+$/, "")) || "/";
          if (path.includes("..")) return reply.code(400).send();
          if (path === "/") return reply.sendFile("index.html");
          if (!env.DEV_TOOLS && (path === "/dev" || path.startsWith("/dev/"))) return reply.code(404).sendFile("404.html"); // simulator page only with dev tools
          if (/\.[a-z0-9]+$/i.test(path) && existsSync(join(webOut, path))) return reply.sendFile(path.slice(1));
          if (existsSync(join(webOut, `${path}.html`))) return reply.sendFile(`${path.slice(1)}.html`);
          return reply.code(404).sendFile("404.html");
        });
        scope.get("/", (_req, reply) => reply.sendFile("index.html"));
      }
    }
  }, { prefix: base });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: "not_found" } }));
  return { app, ctx, ai };
}

function privacyHtml(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const p = join(here, "privacy.html");
  return existsSync(p) ? readFileSync(p, "utf8") : "<h1>Privacy notice</h1>";
}
