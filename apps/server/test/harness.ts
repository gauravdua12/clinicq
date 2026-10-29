import { randomUUID } from "node:crypto";
import { createDb, phoneHash, type Db } from "@clinicq/db";
import { seed, truncateAll, SEED } from "@clinicq/db/seed";
import { buildWebhook, MockWhatsApp, previewText, signBody, type OutMsg } from "@clinicq/wa";
import type { ModelHandle } from "@clinicq/core/extract/index";
import { buildApp } from "../src/app";
import { FakeClock } from "../src/clock";
import { loadEnv } from "../src/env";
import type { Ctx } from "../src/context";

// Scenario harness: real webhook → real services → real Postgres, with a fake clock and mock WhatsApp.

let sharedDb: Db | null = null;

export interface H {
  ctx: Ctx; wa: MockWhatsApp; clock: FakeClock; db: Db;
  app: Awaited<ReturnType<typeof buildApp>>["app"];
  say(from: string, text: string, name?: string): Promise<void>;
  tap(from: string, buttonId: string, title?: string): Promise<void>;
  voice(from: string, spoken: string): Promise<void>;
  image(from: string): Promise<void>;
  flow(from: string, resp: Record<string, unknown>): Promise<void>;
  /** Copy IDs / template names sent to this number, in order (from MessageLog). */
  kinds(from: string): Promise<string[]>;
  last(from: string): OutMsg | undefined;
  lastText(from: string): string;
  buttons(from: string): { id: string; title: string }[];
  at(iso: string): Promise<void>;
  runJobs(): Promise<number>;
  close(): Promise<void>;
}

export const PATIENT = "919876543210";
export const PATIENT2 = "919811122334";
export { SEED };

export async function harness(opts: { start: string; primary?: ModelHandle | null; log?: import("@clinicq/core").Logger } = { start: "2026-10-09T12:00:00+05:30" }): Promise<H> {
  const env = loadEnv();
  sharedDb ??= createDb(env.DATABASE_URL);
  const db = sharedDb;
  const clock = new FakeClock(opts.start);
  const wa = new MockWhatsApp();
  const built = await buildApp({ env, db, wa, clock, serveStatic: false, log: opts.log });
  const { app, ctx } = built;
  if (opts.primary !== undefined) ctx.cascade = async () => ({ primary: opts.primary ?? null, escalation: null, minConfidence: 0.7, timeoutMs: 5000 });
  await truncateAll(db);
  await seed(db, { displayKey: "test-key", slotMinutes: 20 }); // fixtures are written against 20-minute slots
  const { invalidateClinicCache } = await import("../src/services/clinic");
  invalidateClinicCache();

  const post = async (from: string, message: Record<string, unknown>, name?: string) => {
    const payload = JSON.stringify(buildWebhook({ from, name, wamid: `wamid.t.${randomUUID()}`, message }));
    const res = await app.inject({ method: "POST", url: "/webhook", headers: { "content-type": "application/json", "x-hub-signature-256": signBody(payload, env.META_APP_SECRET) }, payload });
    if (res.statusCode !== 200) throw new Error(`webhook ${res.statusCode}`);
  };

  const h: H = {
    ctx, wa, clock, db, app,
    say: (from, text, name = "Ramesh Kumar") => post(from, { type: "text", text: { body: text } }, name),
    tap: (from, id, title) => post(from, { type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: title ?? id } } }),
    voice: async (from, spoken) => {
      const id = `media.${randomUUID()}`;
      wa.media.set(id, { data: Buffer.from(spoken), mime: "audio/ogg; codecs=opus" });
      await post(from, { type: "audio", audio: { id, mime_type: "audio/ogg; codecs=opus", voice: true } });
    },
    image: (from) => post(from, { type: "image", image: { id: `media.${randomUUID()}`, mime_type: "image/jpeg" } }),
    flow: (from, resp) => post(from, { type: "interactive", interactive: { type: "nfm_reply", nfm_reply: { response_json: JSON.stringify(resp) } } }),
    kinds: async (from) => {
      const acc = await db.patientAccount.findFirst({ where: { phoneHash: phoneHash(from) } });
      const staff = acc ? null : await db.staffUser.findUnique({ where: { phoneHash: phoneHash(from) } });
      if (staff) return wa.to(from).map((m) => (m.kind === "template" ? `template:${m.name}` : m.kind));
      const rows = await db.messageLog.findMany({ where: { accountId: acc?.id ?? "none", direction: "OUT" }, orderBy: { createdAt: "asc" } });
      return rows.map((r) => r.kind);
    },
    last: (from) => wa.last(from),
    lastText: (from) => { const m = wa.last(from); return m ? previewText(m) : ""; },
    buttons: (from) => { const m = wa.last(from); return m?.kind === "buttons" ? m.buttons : m?.kind === "list" ? m.sections.flatMap((s) => s.rows) : []; },
    at: async (iso) => { clock.set(iso); await ctx.jobs.runDue(); },
    runJobs: () => ctx.jobs.runDue(),
    close: async () => { await app.close(); },
  };
  return h;
}

/** Fully onboard a patient (consent + number confirmation). */
export async function onboard(h: H, from = PATIENT, name = "Ramesh Kumar"): Promise<void> {
  await h.say(from, "Hi", name);
  await h.tap(from, "consent:yes");
  await h.tap(from, "num:use");
}
