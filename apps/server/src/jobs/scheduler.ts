import type { Db } from "@clinicq/db";
import type { Logger } from "@clinicq/core";
import type { Clock } from "../clock";
import { currentScope, inScope } from "../scope";

// Postgres-backed scheduler (ScheduledJob table). Job payloads hold IDs only — never message text.

export type JobHandler = (data: Record<string, unknown>) => Promise<void>;

/** Remember the clinic scope (src/scope.ts) in the payload: a clinic id, never patient data. */
function withScope(data: Record<string, unknown>): Record<string, unknown> {
  const { clinicId } = currentScope();
  return clinicId ? { ...data, clinicScope: clinicId } : data;
}

export class Scheduler {
  private handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private tickHooks: (() => Promise<void>)[] = [];

  constructor(private db: Db, private clock: Clock, private log: Logger) {}

  on(name: string, h: JobHandler): void { this.handlers.set(name, h); }
  onTick(h: () => Promise<void>): void { this.tickHooks.push(h); }

  /** Upsert by key: rescheduling the same key replaces the pending job. The job runs in the clinic scope it was made in. */
  async schedule(name: string, data: Record<string, unknown>, runAt: Date, key?: string): Promise<void> {
    data = withScope(data);
    if (key) {
      await this.db.scheduledJob.upsert({ where: { key }, create: { name, data: data as never, runAt, key }, update: { name, data: data as never, runAt, doneAt: null } });
    } else {
      await this.db.scheduledJob.create({ data: { name, data: data as never, runAt } });
    }
  }

  /** Schedule only if no job with this key exists yet (idempotent daily jobs). */
  async ensure(name: string, data: Record<string, unknown>, runAt: Date, key: string): Promise<void> {
    data = withScope(data);
    await this.db.scheduledJob.upsert({ where: { key }, create: { name, data: data as never, runAt, key }, update: {} });
  }

  async cancel(key: string): Promise<void> {
    await this.db.scheduledJob.deleteMany({ where: { key, doneAt: null } });
  }

  async cancelPrefix(prefix: string): Promise<void> {
    await this.db.scheduledJob.deleteMany({ where: { key: { startsWith: prefix }, doneAt: null } });
  }

  /** Run every due job once. Returns the number executed. */
  async runDue(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let n = 0;
    try {
      for (const h of this.tickHooks) await h().catch((e) => this.log.error({ err: e }, "tick_hook_failed"));
      for (;;) {
        const now = this.clock.now();
        const rows = await this.db.$queryRaw<{ id: string; name: string; data: Record<string, unknown> }[]>`
          UPDATE "ScheduledJob" SET "doneAt" = ${now}
          WHERE id IN (SELECT id FROM "ScheduledJob" WHERE "doneAt" IS NULL AND "runAt" <= ${now} ORDER BY "runAt" LIMIT 20 FOR UPDATE SKIP LOCKED)
          RETURNING id, name, data`;
        if (!rows.length) break;
        for (const r of rows) {
          const h = this.handlers.get(r.name);
          if (!h) { this.log.warn({ job: r.name }, "no_handler"); continue; }
          const clinicId = typeof r.data?.clinicScope === "string" ? r.data.clinicScope : null;
          if (clinicId && (await this.db.clinic.findUnique({ where: { id: clinicId }, select: { status: true } }))?.status !== "ACTIVE") continue; // suspended, archived or deleted: dropped
          try { await inScope({ clinicId }, () => h(r.data)); n++; } catch (e) { this.log.error({ err: e, job: r.name }, "job_failed"); }
        }
      }
    } finally {
      this.running = false;
    }
    return n;
  }

  /** Poll forever; a failed poll (e.g. database briefly down) is logged and retried, never fatal. */
  start(pollMs: number): void {
    if (this.timer) return;
    const tick = () => this.runDue().catch((e) => { this.running = false; this.log.error({ err: e }, "job_poll_failed"); });
    this.timer = setInterval(tick, pollMs);
    void tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
