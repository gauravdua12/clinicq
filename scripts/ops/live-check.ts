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
const booked_ = async () => booked();
const booked = async () => { const a = await account(); return a ? db.appointment.findMany({ where: { status: "BOOKED", profile: { accountId: a.id } } }) : []; };

// Tomorrow in IST at CHECK_SLOT (default 18:10, an exact slot in the demo clinic); parallel runs use different slots.
const tomorrow = new Date(Date.now() + 5.5 * 3600_000 + 86400_000).toISOString().slice(0, 10);
const [hh, mm] = (process.env.CHECK_SLOT ?? "18:10").split(":").map(Number) as [number, number];
const slotMin = hh * 60 + mm;
const spoken = `${hh < 12 ? "subah" : "shaam"} ${hh > 12 ? hh - 12 : hh}:${String(mm).padStart(2, "0")} baje`;

try {
  // 1. Health and webhook security
  check("health", (await (await fetch(`${BASE}/healthz`)).json() as { ok: boolean }).ok);
  check("webhook verify: wrong token refused", (await fetch(`${BASE}/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=x`)).status === 403);
  const ch = await (await fetch(`${BASE}/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(process.env.META_VERIFY_TOKEN!)}&hub.challenge=abc123`)).text();
  check("webhook verify: right token echoes challenge", ch === "abc123");
  check("unsigned webhook refused", (await fetch(`${BASE}/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status === 401);
  check("dev tools are off in production", (await fetch(`${BASE}/dev/clock`, { method: "POST" })).status === 404 && (await fetch(`${BASE}/dev/simulator`)).status === 404);

  // 2. A full booking through the live AI, answering whatever the bot asks next
  const first = `kal ${spoken} mummy ke liye appointment chahiye, unka naam Sunita hai`;
  check("first message accepted", (await say(first)) === 200);
  const seen: string[] = [];
  for (let i = 0; i < 10 && !(await booked()).length; i++) {
    const s = await state();
    seen.push(s);
    if (s === "AWAIT_CONSENT") await tap("consent:yes");
    else if (s === "AWAIT_NUMBER_CONFIRM") await tap("num:use");
    else if (s === "BK_WHO") await tap("who:other");
    else if (s === "BK_NAME") await say("Sunita");
    else if (s === "BK_WHEN" || s === "IDLE") await say(`kal ${spoken} mummy ke liye`);
    else if (s === "BK_PICK_SLOT") await tap(`slot:${tomorrow}|${slotMin}`);
    else if (s === "BK_VISIT_TYPE") await tap("vt:NEW");
    else if (s === "BK_CONFIRM") await tap("bk:yes");
    else if (s === "BK_SAME_FAMILY") await tap("who:other");
    else break;
  }
  const appts = await booked();
  check("booking completed through the live conversation", appts.length === 1, `states: ${seen.join(" → ")}`);
  const want = `${tomorrow}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  const slotOk = appts[0] && new Date(appts[0].slotStart.getTime() + 5.5 * 3600_000).toISOString().slice(0, 16) === want;
  check(`booked the requested slot (${want} IST)`, !!slotOk, appts[0]?.slotStart.toISOString());
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

  // 5. Booking page (form D): the link the bot sends, its API, and a confirmed booking through it
  if ((await state()) === "BK_VISIT_TYPE") await tap("vt:NEW"); // finish what the duplicate-check message started
  if ((await state()) === "BK_CONFIRM") await tap("bk:yes");
  await say("ek aur appointment chahiye mere liye");
  if ((await state()) === "BK_WHO") await tap("who:me");
  const accNow = await account();
  const link = accNow ? await db.flowToken.findFirst({ where: { accountId: accNow.id }, orderBy: { expiresAt: "desc" } }) : null;
  check("booking link created for the patient", !!link, link ? undefined : `state ${await state()}`);
  if (link) {
    const info = await (await fetch(`${BASE}/api/book/${link.token}`)).json() as { dates: { date: string; enabled: boolean }[] };
    const open = info.dates.filter((d) => d.enabled).map((d) => d.date);
    let booked = false;
    for (const d of open.slice(1, 4)) {
      const day = await (await fetch(`${BASE}/api/book/${link.token}/day/${d}`)).json() as { sessions: { slots: { min: number; free: boolean }[] }[] };
      const free = day.sessions.flatMap((x) => x.slots).find((x) => x.free);
      if (!free) continue;
      const before = (await booked_()).length;
      const r = await fetch(`${BASE}/api/book/${link.token}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ date: d, min: free.min, visitType: "NEW" }) });
      booked = r.status === 200 && (await booked_()).length === before + 1;
      break;
    }
    check("booking page: dates, slots and confirm work", booked);
    check("booking link works only once", (await fetch(`${BASE}/api/book/${link.token}`)).status === 410);
  }

  // 6. Erasure through the bot itself (also cleans up this check)
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
