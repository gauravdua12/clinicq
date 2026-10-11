/**
 * Post-deploy check on the server (talks to the local app, real AI, real database). Run as the clinicq user
 * with the production env loaded:
 *   sudo -u clinicq -H bash -c 'set -a; . /etc/clinicq/clinicq.env; set +a; cd /opt/clinicq/app && npx tsx scripts/ops/live-check.ts'
 * A fake patient (9198000xxxxx, never a real WhatsApp user) books through the live conversation engine; outbound
 * WhatsApp sends to it fail at Meta by design. At the end the patient deletes their data through the bot itself,
 * so nothing is left behind. Exit code 1 if any check fails.
 */
import { randomInt, randomUUID } from "node:crypto";
import { createDb, decrypt, initCrypto, phoneHash } from "../../packages/db/src";
import { buildWebhook, signBody } from "../../packages/wa/src/webhook";

const BASE = `http://127.0.0.1:${process.env.PORT ?? 8090}${process.env.BASE_PATH ?? ""}`;
const SECRET = process.env.META_APP_SECRET!;
initCrypto({ dataKeyB64: process.env.DATA_KEY!, pepperB64: process.env.HASH_PEPPER! });
const db = createDb(process.env.DATABASE_URL!);
const FROM = `9198000${String(randomInt(0, 100000)).padStart(5, "0")}`;
const results: [string, boolean, string?][] = [];
const check = (name: string, ok: boolean, info?: string) => { results.push([name, ok, info]); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? `  (${info})` : ""}`); };

async function post(message: Record<string, unknown>, opts: { wamid?: string; ageMin?: number } = {}): Promise<number> {
  const p = buildWebhook({ from: FROM, name: "Live Check", wamid: opts.wamid ?? `wamid.live.${randomUUID()}`, message }) as { entry: { changes: { value: { messages: { timestamp: string }[] } }[] }[] };
  p.entry[0]!.changes[0]!.value.messages[0]!.timestamp = String(Math.floor(Date.now() / 1000 - (opts.ageMin ?? 0) * 60));
  const raw = JSON.stringify(p);
  const r = await fetch(`${BASE}/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signBody(raw, SECRET) }, body: raw });
  return r.status;
}
const say = (body: string, o?: { wamid?: string; ageMin?: number }) => post({ type: "text", text: { body } }, o);
const tap = (id: string) => post({ type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: id } } });
const account = () => db.patientAccount.findUnique({ where: { phoneHash: phoneHash(FROM) } });
const state = async () => { const a = await account(); return a ? (await db.conversationState.findUnique({ where: { accountId: a.id } }))?.state ?? "IDLE" : "NONE"; };
const booked = async () => { const a = await account(); return a ? db.appointment.findMany({ where: { status: "BOOKED", profile: { accountId: a.id } } }) : []; };

// Tomorrow in IST, 6:10 PM (an exact evening slot in the demo clinic).
const tomorrow = new Date(Date.now() + 5.5 * 3600_000 + 86400_000).toISOString().slice(0, 10);

try {
  // 1. Health and webhook security
  check("health", (await (await fetch(`${BASE}/healthz`)).json() as { ok: boolean }).ok);
  check("webhook verify: wrong token refused", (await fetch(`${BASE}/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=x`)).status === 403);
  const ch = await (await fetch(`${BASE}/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(process.env.META_VERIFY_TOKEN!)}&hub.challenge=abc123`)).text();
  check("webhook verify: right token echoes challenge", ch === "abc123");
  check("unsigned webhook refused", (await fetch(`${BASE}/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status === 401);
  check("dev tools are off in production", (await fetch(`${BASE}/dev/clock`, { method: "POST" })).status === 404);

  // 2. A full booking through the live AI, answering whatever the bot asks next
  const first = "kal shaam 6:10 baje mummy ke liye appointment chahiye, unka naam Sunita hai";
  check("first message accepted", (await say(first)) === 200);
  const seen: string[] = [];
  for (let i = 0; i < 10 && !(await booked()).length; i++) {
    const s = await state();
    seen.push(s);
    if (s === "AWAIT_CONSENT") await tap("consent:yes");
    else if (s === "AWAIT_NUMBER_CONFIRM") await tap("num:use");
    else if (s === "BK_WHO") await tap("who:other");
    else if (s === "BK_NAME") await say("Sunita");
    else if (s === "BK_WHEN" || s === "IDLE") await say("kal shaam 6:10 baje mummy ke liye");
    else if (s === "BK_PICK_SLOT") await tap(`slot:${tomorrow}|${18 * 60 + 10}`);
    else if (s === "BK_VISIT_TYPE") await tap("vt:NEW");
    else if (s === "BK_SAME_FAMILY") await tap("who:other");
    else break;
  }
  const appts = await booked();
  check("booking completed through the live conversation", appts.length === 1, `states: ${seen.join(" → ")}`);
  const slotOk = appts[0] && new Date(appts[0].slotStart.getTime() + 5.5 * 3600_000).toISOString().slice(0, 16) === `${tomorrow}T18:10`;
  check("booked the requested slot (tomorrow 6:10 PM)", !!slotOk, appts[0]?.slotStart.toISOString());
  const prof = appts[0]?.profileId ? await db.patientProfile.findUnique({ where: { id: appts[0].profileId } }) : null;
  const name = prof?.name ? decrypt(prof.name) : "";
  check("patient name understood as Sunita (stored encrypted)", /sunita/i.test(name) && !/sunita/i.test(prof?.name ?? ""), name || "none");

  // 3. Data boundary: the raw message text is nowhere in the database
  const acc = await account();
  const conv = acc ? await db.conversationState.findUnique({ where: { accountId: acc.id } }) : null;
  const dump = JSON.stringify(conv?.context ?? {}) + JSON.stringify(await db.messageLog.findMany({ where: { accountId: acc?.id } })) + JSON.stringify(await db.auditLog.findMany({ orderBy: { at: "desc" }, take: 50 }));
  check("raw message text not stored", !/chahiye|shaam|baje/i.test(dump));

  // 4. Duplicate delivery and stale re-delivery are not acted on
  const before = (await booked()).length;
  const wamid = `wamid.live.dup.${randomUUID()}`;
  await say("parso subah 10 baje bhi ek appointment", { wamid });
  const afterFirst = await state();
  await say("parso subah 10 baje bhi ek appointment", { wamid });
  check("duplicate delivery processed once", (await state()) === afterFirst);
  const appCountBefore = await db.appointment.count();
  check("stale re-delivery (2 h old) accepted by webhook", (await say("kal subah 11 baje appointment", { ageMin: 120 })) === 200);
  check("stale re-delivery not acted on", (await db.appointment.count()) === appCountBefore && (await booked()).length >= before);

  // 5. Erasure through the bot itself (also cleans up this check)
  await say("delete my data");
  if ((await state()) === "ERASE_CONFIRM") await tap("erase:yes");
  check("patient erased their data via WhatsApp", (await account()) === null);
  const left = appts[0] ? await db.appointment.findUnique({ where: { id: appts[0].id } }) : null;
  check("their booking was released", !left || left.status === "CANCELLED", left?.status);
} catch (e) {
  check("unexpected error", false, String(e));
} finally {
  await db.$disconnect();
}
const failed = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} checks passed (test number ${FROM.slice(0, 7)}xxxxx)`);
process.exit(failed ? 1 : 0);
