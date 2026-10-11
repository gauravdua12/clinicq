import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "@clinicq/core";
import type { ModelHandle } from "@clinicq/core/extract/index";
import { rulesExtract } from "@clinicq/core/extract/index";
import { previewText } from "@clinicq/wa";
import { harness, onboard, PATIENT, type H } from "../harness";
import { createProfile } from "../../src/services/patients";

// Data-boundary suite (docs/TESTING.md §5): health details never reach the DB, logs, outbound messages
// or the model provider beyond the message itself; images are never downloaded.

const CANARIES = ["CANARY7f3a", "bukhar teen din se sugar 300", "paracetamol 650", "chest pain", "thyroid TSH 8.2"];

describe("data boundary", () => {
  let h: H;
  let logs = "";
  const prompts: string[] = [];
  // A fake model that records what the provider would receive and answers like the rules extractor.
  const spy: ModelHandle = {
    spec: "spy:model",
    async call(_system, user) {
      prompts.push(user);
      const msg = user.match(/Message: """([\s\S]*)"""/)?.[1] ?? "";
      return { json: { ...rulesExtract(msg, { today: "2026-10-09", nowTime: "12:00", sessions: [], profiles: [], state: "IDLE" }), confidence: 0.95 } };
    },
  };

  beforeAll(async () => {
    const dest = new Writable({ write(c, _e, cb) { logs += c.toString(); cb(); } });
    h = await harness({ start: "2026-10-09T12:00:00+05:30", primary: spy, log: createLogger({ level: "debug", destination: dest as never }) });
    await onboard(h);
    await createProfile(h.ctx, (await h.db.patientAccount.findFirstOrThrow()).id, "Ramesh Kumar", "SELF");
    // Send the canaries every way a patient can.
    await h.say(PATIENT, "CANARY7f3a kal subah appointment, bukhar teen din se sugar 300");
    await h.say(PATIENT, "should I take paracetamol 650 before coming?");
    await h.voice(PATIENT, "CANARY7f3a thyroid TSH 8.2 report dikhani hai kal");
    await h.image(PATIENT);
    await h.say(PATIENT, "papa ko chest pain ho raha hai");
    await h.say(PATIENT, "Monday 10:20");
    await h.tap(PATIENT, "vt:REPORT_SHOW");
    await h.say(PATIENT, "mera number kab aayega CANARY7f3a");
    await h.flow(PATIENT, { slot: "2026-10-12|660", note: "CANARY7f3a injected" });
  });
  afterAll(async () => h.close());

  it("nothing in any table (including jobs) contains the canaries", async () => {
    const cols = await h.db.$queryRaw<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type IN ('text', 'character varying', 'jsonb', 'json')`;
    for (const c of cols) {
      for (const canary of CANARIES) {
        const rows = await h.db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM "${c.table_name}" WHERE "${c.column_name}"::text ILIKE $1`, `%${canary}%`);
        expect(Number(rows[0]!.n), `${c.table_name}.${c.column_name} contains "${canary}"`).toBe(0);
      }
    }
  });

  it("logs never contain message text or phone numbers", () => {
    expect(logs.length).toBeGreaterThan(0);
    for (const canary of CANARIES) expect(logs).not.toContain(canary);
    expect(logs).not.toMatch(/9876543210/);
  });

  it("the bot never echoes health details back", () => {
    for (const m of h.wa.sent) for (const canary of CANARIES) expect(previewText(m.msg)).not.toContain(canary);
  });

  it("images are never downloaded; only the voice note is (in memory)", () => {
    expect(h.wa.mediaDownloads).toHaveLength(1);
  });

  it("the model provider never receives phone numbers or stored names", () => {
    expect(prompts.length).toBeGreaterThan(0);
    for (const p of prompts) {
      expect(p).not.toMatch(/9876543210|98765 43210/);
      expect(p).not.toContain("Ramesh");
      expect(p).toMatch(/P1 relation=SELF|none yet/);
    }
  });

  it("emergency reply was sent, and only a counter was stored", async () => {
    const kinds = await h.kinds(PATIENT);
    expect(kinds).toContain("EMERGENCY_REPLY");
    expect(await h.db.messageLog.count({ where: { kind: "emergency_reply_sent" } })).toBe(1);
  });

  it("schema guard: no free-text clinical fields exist", async () => {
    const cols = await h.db.$queryRaw<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`;
    const bad = cols.filter((c) => /reason|note|symptom|complaint|diagnos|medic|history|description|remark|prescri|transcript|caption/i.test(c.column_name));
    expect(bad).toEqual([]);
  });
});
