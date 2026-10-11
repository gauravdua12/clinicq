/**
 * Live-AI load: N onboarded patients send free-text booking messages concurrently through the real
 * cascade (Qwen3 32B → Mistral Large 3). Measures end-to-end webhook latency, failover rate and errors.
 *   npx tsx scripts/load/live.ts --base http://localhost:8098 --n 120 --c 30
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { buildWebhook, signBody } from "../../packages/wa/src/webhook";
if ((await import("node:fs")).existsSync(".env")) process.loadEnvFile(".env");
const a = (k: string, d: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1]! : d);
const BASE = a("--base", "http://localhost:8098");
const N = Number(a("--n", "120"));
const C = Number(a("--c", "30"));
const SECRET = process.env.META_APP_SECRET ?? "dev-app-secret";
let seq = 0;
const send = async (from: string, message: Record<string, unknown>) => {
  const payload = JSON.stringify(buildWebhook({ from, name: "Live Load", wamid: `wamid.live.${Date.now()}.${seq++}`, message }));
  const t0 = performance.now();
  const r = await fetch(`${BASE}/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signBody(payload, SECRET) }, body: payload });
  return { code: r.status, ms: performance.now() - t0 };
};
const phrases = ["kal shaam 6 baje mummy ke liye appointment", "need appointment monday morning for my son", "मुझे मंगलवार शाम 7 बजे दिखाना है", "tmrw 11am pls for me", "wednesday evening after 6 for my wife", "parso subah 10 baje", "can I come thursday around 5:30 pm", "appointment chahiye saturday shaam"];
const phone = (k: number) => `9197${String(10_000_000 + k).slice(-8)}`;
await fetch(`${BASE}/dev/clock`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ now: "2026-10-09T12:00:00+05:30" }) });
const ps = Array.from({ length: N }, (_, k) => phone(k));
for (const p of ps) { await send(p, { type: "text", text: { body: "Hi" } }); await send(p, { type: "interactive", interactive: { type: "button_reply", button_reply: { id: "consent:yes", title: "ok" } } }); await send(p, { type: "interactive", interactive: { type: "button_reply", button_reply: { id: "num:use", title: "ok" } } }); }
const ms: number[] = [];
const codes: Record<number, number> = {};
let i = 0;
const t0 = performance.now();
await Promise.all(Array.from({ length: C }, async () => {
  while (i < ps.length) {
    const k = i++;
    const r = await send(ps[k]!, { type: "text", text: { body: phrases[k % phrases.length]! } });
    ms.push(r.ms); codes[r.code] = (codes[r.code] ?? 0) + 1;
  }
}));
const wall = (performance.now() - t0) / 1000;
const s = [...ms].sort((x, y) => x - y);
const q = (p: number) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]!);
const line = `| live AI · ${N} msgs · concurrency ${C} | ${JSON.stringify(codes)} | ${q(0.5)} | ${q(0.95)} | ${q(0.99)} | ${(N / wall).toFixed(1)} msg/s |`;
mkdirSync("test-results/load", { recursive: true });
appendFileSync("test-results/load/live.md", line + "\n");
console.log(line);
