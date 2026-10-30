import { buildApp } from "./app";
import { loadEnv } from "./env";

const env = loadEnv();

// Safety net: a stray promise rejection (e.g. DB connection dropped) must not take the clinic offline.
process.on("unhandledRejection", (reason) => { console.error(JSON.stringify({ level: 50, msg: "unhandled_rejection", err: (reason as Error)?.name ?? String(reason) })); });
process.on("uncaughtException", (err) => { console.error(JSON.stringify({ level: 60, msg: "uncaught_exception", err: err.name })); process.exit(1); }); // systemd restarts us
const { app, ctx } = await buildApp({ env });
await (await import("./routes/auth")).ensureReviewer(ctx).catch((e) => ctx.log.error({ err: e }, "reviewer_setup_failed"));
await (await import("./services/admins")).ensureAdmins(ctx).catch((e) => ctx.log.error({ err: e }, "admins_failed"));
if (env.DEMO_STUDIO) await (await import("./services/demo")).ensurePresenters(ctx).catch((e) => ctx.log.error({ err: e }, "presenters_failed"));
ctx.jobs.start(env.JOB_POLL_MS);
await app.listen({ port: env.PORT, host: env.HOST });
ctx.log.info({ port: env.PORT, wa: env.WA_MODE }, "clinicq_started");

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    ctx.jobs.stop();
    await app.close();
    await ctx.db.$disconnect();
    process.exit(0);
  });
}
