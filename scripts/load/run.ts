/**
 * Load & break-point tests against a running server (default http://localhost:8097, mock WhatsApp,
 * rules extractor unless --live). Produces test-results/load/report.md.
 *
 *   npx tsx scripts/load/run.ts [--base http://localhost:8097] [--live]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { buildWebhook, signBody } from "../../packages/wa/src/webhook";

if (process.env.NODE_ENV !== "test" && (await import("node:fs")).existsSync(".env")) process.loadEnvFile(".env");
const BASE = process.argv.includes("--base") ? process.argv[process.argv.indexOf("--base") + 1]! : "http://localhost:8097";
const SECRET = process.env.META_APP_SECRET ?? "dev-app-secret";
let seq = 0;

interface Stat { name: string; n: number; ok: number; errors: number; codes: Record<string, number>; ms: number[]; wallMs: number }
const pct = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]!) : 0; };

async function webhook(from: string, message: Record<string, unknown>): Promise<number> {
  const payload = JSON.stringify(buildWebhook({ from, name: "Load Test", wamid: `wamid.load.${Date.now()}.${seq++}`, message }));
  const r = await fetch(`${BASE}/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signBody(payload, SECRET) }, body: payload });
  return r.status;
}
const text = (from: string, body: string) => webhook(from, { type: "text", text: { body } });
const tap = (from: string, id: string) => webhook(from, { type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: id } } });

async function run(name: string, jobs: (() => Promise<number>)[], concurrency: number): Promise<Stat> {
  const st: Stat = { name, n: jobs.length, ok: 0, errors: 0, codes: {}, ms: [], wallMs: 0 };
  let i = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < jobs.length) {
      const job = jobs[i++]!;
      const s = performance.now();
      try {
        const code = await job();
        st.codes[code] = (st.codes[code] ?? 0) + 1;
        if (code >= 200 && code < 300) st.ok++; else st.errors++;
      } catch (e) { st.errors++; st.codes[(e as Error).name] = (st.codes[(e as Error).name] ?? 0) + 1; }
      st.ms.push(performance.now() - s);
    }
  }));
  st.wallMs = performance.now() - t0;
  process.stderr.write(`${name}: ${st.ok}/${st.n} ok · p50 ${pct(st.ms, 0.5)} ms · p95 ${pct(st.ms, 0.95)} ms · p99 ${pct(st.ms, 0.99)} ms · ${(st.n / (st.wallMs / 1000)).toFixed(1)} req/s\n`);
  return st;
}

async function devLogin(): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/dev-login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "DOCTOR" }) });
  return (r.headers.get("set-cookie") ?? "").split(";")[0]!;
}

const phone = (k: number) => `9198${String(10_000_000 + k).slice(-8)}`;
const results: Stat[] = [];
const notes: string[] = [];

await fetch(`${BASE}/dev/clock`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ now: "2026-10-09T17:30:00+05:30" }) });
const cookie = await devLogin();
const mem0 = await (await fetch(`${BASE}/healthz`)).json();

// L1 — first contact from many new patients (consent flow), ramping concurrency
for (const c of [10, 50, 100, 200]) {
  const base = c * 1000;
  results.push(await run(`L1 first message × 400, concurrency ${c}`, Array.from({ length: 400 }, (_, k) => () => text(phone(base + k), "Hi, appointment chahiye")), c));
}

// L2 — onboard 200 patients fully, then all ask for the SAME slot at once (booking storm)
const N2 = 200;
const p2 = Array.from({ length: N2 }, (_, k) => phone(900_000 + k));
await run("L2 setup: consent + number", p2.flatMap((p) => [() => text(p, "Hi"), () => tap(p, "consent:yes"), () => tap(p, "num:use")]), 1);
await run("L2 setup: 'book appointment' → for me (now asked: which day/time)", p2.flatMap((p) => [() => text(p, "book appointment"), () => tap(p, "who:me")]), 20);
results.push(await run("L2 storm: 200 patients answer 'tomorrow 6:10 pm' simultaneously", p2.map((p) => () => text(p, "tomorrow 6:10 pm")), 200));
results.push(await run("L2 storm: tap the visit type", p2.map((p) => () => tap(p, "vt:NEW")), 200));
const appts = await (await fetch(`${BASE}/api/appointments?from=2026-10-10&to=2026-10-10`, { headers: { cookie } })).json() as { time: string }[];
const at610 = appts.filter((a) => a.time === "6:10 PM").length;
notes.push(`L2 integrity: ${appts.length} bookings on Sat; bookings at 6:10 PM = **${at610}** (must be ≤ 1). Slots are ${appts.length <= 13 ? "within" : "OVER"} the session capacity.`);

// L3 — walk-in rush: 150 walk-ins join in 1 minute via QR (quota 8/session → overflow to staff)
const qr = await (await fetch(`${BASE}/api/settings/qr`, { headers: { cookie } })).json() as { text: string };
const p3 = Array.from({ length: 150 }, (_, k) => phone(950_000 + k));
await run("L3 setup", p3.flatMap((p) => [() => text(p, qr.text), () => tap(p, "consent:yes"), () => tap(p, "num:use")]), 20);
results.push(await run("L3 walk-in rush: 150 names at once", p3.map((p, k) => () => text(p, `Patient Number${k}`)), 150));

// L4 — dashboard reads + queue taps while patients chat
results.push(await run("L4 dashboard GET /api/queue/today × 2000 (concurrency 50)", Array.from({ length: 2000 }, () => async () => (await fetch(`${BASE}/api/queue/today`, { headers: { cookie } })).status), 50));
results.push(await run("L4 'consultation completed' × 60 while dashboards poll", Array.from({ length: 60 }, () => async () => (await fetch(`${BASE}/api/queue/advance`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" })).status), 10));

// L5 — 300 live SSE connections (dashboards/TVs) receive updates
const controllers: AbortController[] = [];
let received = 0;
await Promise.all(Array.from({ length: 300 }, async () => {
  const ac = new AbortController();
  controllers.push(ac);
  const r = await fetch(`${BASE}/api/events`, { headers: { cookie }, signal: ac.signal });
  const reader = r.body!.getReader();
  void (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; if (new TextDecoder().decode(value).includes("queue.updated")) received++; } } catch { /* aborted */ } })();
}));
await fetch(`${BASE}/api/queue/walkin`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "SSE Probe" }) });
await new Promise((r) => setTimeout(r, 2000));
notes.push(`L5 SSE: 300 open connections; **${received}** received the queue update (expect ≥ 300).`);
controllers.forEach((c) => c.abort());

// L6 — garbage & abuse: malformed JSON, bad signatures, huge bodies, rapid-fire from one number
const bad = await Promise.all([
  fetch(`${BASE}/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signBody("{nope", SECRET) }, body: "{nope" }).then((r) => r.status),
  fetch(`${BASE}/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=00" }, body: "{}" }).then((r) => r.status),
  fetch(`${BASE}/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(2_000_000) }).then((r) => r.status).catch(() => "reset"),
  text(phone(1), "A".repeat(20000)),
  text(phone(2), "'; DROP TABLE \"Appointment\"; --"),
  text(phone(3), "\u0000‮😀".repeat(500)),
]);
notes.push(`L6 abuse responses (malformed JSON, bad signature, 2 MB body, 20k-char text, SQL-like text, control/RTL chars): ${bad.join(", ")}`);
const spam = await run("L6 rapid-fire: 60 messages from one number", Array.from({ length: 60 }, (_, k) => () => text(phone(4), `hello ${k}`)), 60);
results.push(spam);
const health = await (await fetch(`${BASE}/healthz`)).json();
notes.push(`Health after all tests: ${JSON.stringify(health)} (before: ${JSON.stringify(mem0)})`);

mkdirSync("test-results/load", { recursive: true });
const rows = results.map((s) => `| ${s.name} | ${s.ok}/${s.n} | ${Object.entries(s.codes).map(([k, v]) => `${k}×${v}`).join(" ")} | ${pct(s.ms, 0.5)} | ${pct(s.ms, 0.95)} | ${pct(s.ms, 0.99)} | ${(s.n / (s.wallMs / 1000)).toFixed(1)} |`);
const md = [`# Load test (${new Date().toISOString().slice(0, 16)}) — ${BASE}`, "", "| Scenario | OK | Status codes | p50 ms | p95 ms | p99 ms | req/s |", "|---|---|---|---|---|---|---|", ...rows, "", ...notes.map((n) => `- ${n}`)].join("\n");
writeFileSync("test-results/load/report.md", md + "\n");
console.log(md);
