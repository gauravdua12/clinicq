/**
 * Model bake-off for message understanding (docs/AI_EXTRACTION.md §7).
 *
 *   npm run eval:extract -- --models bedrock:openai.gpt-oss-20b-1:0,rules
 *   npm run eval:extract -- --cascade bedrock:google.gemma-3-12b-it>anthropic-bedrock:in.anthropic.claude-haiku-4-5-20251001-v1:0
 *   npm run eval:extract -- --all-economy --repeat 2
 *
 * Costs real money (small): each model × case is one request. Reports → packages/ai/eval/reports/.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MODEL_CATALOG, PROMPT_VERSION, SYSTEM_PROMPT, costUsd, extract, normalizeModelJson, postValidate,
  renderUserTurn, rulesExtract, type ExtractContext, type Extraction, type ModelHandle,
} from "@clinicq/core/extract/index";
import { modelFromSpec } from "../src/providers";
import { BASE_CTX, CASES, type EvalCase } from "./cases";
import { HOLDOUT } from "./holdout";

const USD_INR = 88;
const here = dirname(fileURLToPath(import.meta.url));

type Arg = { models: string[]; cascades: [string, string][]; only?: string; set: string; concurrency: number; repeat: number; timeoutMs: number };
function parseArgs(): Arg {
  const a = process.argv.slice(2);
  const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  let models = (get("--models") ?? "").split(",").filter(Boolean);
  if (a.includes("--all-economy")) models = [...models, ...MODEL_CATALOG.filter((m) => m.tier === "economy").map((m) => m.spec)];
  if (a.includes("--all")) models = [...models, ...MODEL_CATALOG.map((m) => m.spec), "rules"];
  const cascades = (get("--cascade") ?? "").split(",").filter(Boolean).map((c) => c.split(">") as [string, string]);
  return { models: [...new Set(models)], cascades, only: get("--only"), set: get("--set") ?? "both", concurrency: Number(get("--concurrency") ?? 4), repeat: Number(get("--repeat") ?? 1), timeoutMs: Number(get("--timeout") ?? 8000) };
}

const SCORED = ["intent", "date", "time", "timeQualifier", "partOfDay", "forWhom", "profileRef", "relation", "newPersonName", "selfName", "phone", "visitType", "clinicInfoTopic", "language"] as const;
const CRITICAL = new Set(["intent", "date", "time", "forWhom", "profileRef", "phone", "visitType"]);

function eq(field: string, got: unknown, want: unknown): boolean {
  const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : v);
  if (Array.isArray(want)) return want.some((w) => eq(field, got, w));
  if (field === "newPersonName" || field === "selfName") {
    if (want == null) return got == null;
    return typeof got === "string" && norm(got)!.toString().includes(String(norm(want)));
  }
  return norm(got) === norm(want);
}

interface CaseResult {
  id: string; cat: string; valid: boolean; latencyMs: number; inTok: number; outTok: number; costUsd: number;
  escalated?: boolean; source?: string;
  fields: Record<string, boolean>; allOk: boolean; criticalOk: boolean;
  medExpected?: boolean; medGot?: boolean; emgExpected?: boolean; emgGot?: boolean; error?: string;
  got?: Partial<Extraction>;
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      const name = (e as { name?: string }).name ?? "";
      if (i < 4 && /Throttl|TooManyRequests|ServiceUnavailable|ModelNotReady|429|503/.test(name)) { await new Promise((r) => setTimeout(r, 1500 * 2 ** i)); continue; }
      throw e;
    }
  }
}

function score(c: EvalCase, e: Extraction | null): Pick<CaseResult, "fields" | "allOk" | "criticalOk" | "medExpected" | "medGot" | "emgExpected" | "emgGot"> {
  const fields: Record<string, boolean> = {};
  for (const f of SCORED) {
    if (!(f in c.expect)) continue;
    fields[f] = !!e && eq(f, e[f as keyof Extraction], (c.expect as Record<string, unknown>)[f]);
  }
  const r = {
    fields,
    allOk: Object.values(fields).every(Boolean),
    criticalOk: Object.entries(fields).filter(([k]) => CRITICAL.has(k)).every(([, v]) => v),
    medExpected: c.expect.hasNonBookingContent, medGot: e?.hasNonBookingContent,
    emgExpected: c.expect.possibleEmergency, emgGot: e?.possibleEmergency,
  };
  // Safety flags are part of "all ok" too.
  if (c.expect.hasNonBookingContent !== undefined && e?.hasNonBookingContent !== c.expect.hasNonBookingContent) r.allOk = false;
  if (c.expect.possibleEmergency !== undefined && e?.possibleEmergency !== c.expect.possibleEmergency) r.allOk = false;
  return r;
}

async function runSingle(spec: string, c: EvalCase, timeoutMs: number): Promise<CaseResult> {
  const ctx: ExtractContext = { ...BASE_CTX, ...c.ctx };
  if (spec === "rules") {
    const t0 = performance.now();
    const e = rulesExtract(c.text, ctx);
    return { id: c.id, cat: c.cat, valid: true, latencyMs: performance.now() - t0, inTok: 0, outTok: 0, costUsd: 0, ...score(c, e), got: e };
  }
  const h = modelFromSpec(spec, { awsRegion: process.env.AWS_REGION ?? "ap-south-1", openaiCompatBaseUrl: process.env.OPENAI_COMPAT_BASE_URL })!;
  const t0 = performance.now();
  try {
    const r = await withRetry(() => h.call(SYSTEM_PROMPT, renderUserTurn(c.text, ctx), timeoutMs));
    const latencyMs = performance.now() - t0;
    const n = normalizeModelJson(r.json);
    const e = n ? postValidate(n.value, ctx) : null;
    return { id: c.id, cat: c.cat, valid: !!n, latencyMs, inTok: r.inputTokens ?? 0, outTok: r.outputTokens ?? 0, costUsd: costUsd(spec, r.inputTokens, r.outputTokens) ?? 0, ...score(c, e), got: e ?? undefined };
  } catch (err) {
    return { id: c.id, cat: c.cat, valid: false, latencyMs: performance.now() - t0, inTok: 0, outTok: 0, costUsd: 0, ...score(c, null), error: (err as Error).name + ": " + String((err as Error).message).slice(0, 160) };
  }
}

async function runCascade(primary: string, escalation: string, c: EvalCase, timeoutMs: number): Promise<CaseResult> {
  const ctx: ExtractContext = { ...BASE_CTX, ...c.ctx };
  const opts = { awsRegion: process.env.AWS_REGION ?? "ap-south-1" };
  const wrap = (h: ModelHandle | null): ModelHandle | null => h && { spec: h.spec, call: (s, u, t) => withRetry(() => h.call(s, u, t)) };
  const t0 = performance.now();
  const out = await extract(c.text, ctx, { primary: wrap(modelFromSpec(primary, opts)), escalation: wrap(modelFromSpec(escalation, opts)), minConfidence: 0.7, timeoutMs });
  const latencyMs = performance.now() - t0;
  const cost = out.calls.reduce((s, k) => s + (costUsd(k.spec, k.inputTokens, k.outputTokens) ?? 0), 0);
  return {
    id: c.id, cat: c.cat, valid: out.source !== "rules" || out.calls.length === 0, latencyMs,
    inTok: out.calls.reduce((s, k) => s + (k.inputTokens ?? 0), 0), outTok: out.calls.reduce((s, k) => s + (k.outputTokens ?? 0), 0),
    costUsd: cost, escalated: out.escalated, source: out.source, ...score(c, out.extraction), got: out.extraction,
  };
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]!); }));
}

function pct(n: number, d: number) { return d ? Math.round((1000 * n) / d) / 10 : NaN; }
function quantile(xs: number[], q: number) { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : 0; }

function summarize(label: string, rs: CaseResult[]) {
  const n = rs.length;
  const med = rs.filter((r) => r.medExpected === true);
  const medNeg = rs.filter((r) => r.medExpected === false);
  const emg = rs.filter((r) => r.emgExpected === true);
  const emgNeg = rs.filter((r) => r.emgExpected === false);
  const intent = rs.filter((r) => "intent" in r.fields);
  const fieldAcc: Record<string, number> = {};
  for (const f of SCORED) { const xs = rs.filter((r) => f in r.fields); if (xs.length) fieldAcc[f] = pct(xs.filter((r) => r.fields[f]).length, xs.length); }
  const byCat: Record<string, number> = {};
  for (const cat of [...new Set(rs.map((r) => r.cat))]) { const xs = rs.filter((r) => r.cat === cat); byCat[cat] = pct(xs.filter((r) => r.allOk).length, xs.length); }
  const costPer = rs.reduce((s, r) => s + r.costUsd, 0) / n;
  return {
    model: label, cases: n,
    validPct: pct(rs.filter((r) => r.valid).length, n),
    allFieldsPct: pct(rs.filter((r) => r.allOk).length, n),
    criticalPct: pct(rs.filter((r) => r.criticalOk).length, n),
    intentPct: pct(intent.filter((r) => r.fields.intent).length, intent.length),
    medicalRecallPct: pct(med.filter((r) => r.medGot === true).length, med.length),
    medicalFalsePosPct: pct(medNeg.filter((r) => r.medGot === true).length, medNeg.length),
    emergencyRecallPct: pct(emg.filter((r) => r.emgGot === true).length, emg.length),
    emergencyFalsePosPct: pct(emgNeg.filter((r) => r.emgGot === true).length, emgNeg.length),
    escalatedPct: rs.some((r) => r.escalated !== undefined) ? pct(rs.filter((r) => r.escalated).length, n) : undefined,
    p50ms: Math.round(quantile(rs.map((r) => r.latencyMs), 0.5)), p95ms: Math.round(quantile(rs.map((r) => r.latencyMs), 0.95)),
    avgInTok: Math.round(rs.reduce((s, r) => s + r.inTok, 0) / n), avgOutTok: Math.round(rs.reduce((s, r) => s + r.outTok, 0) / n),
    usdPer1kMsgs: Math.round(costPer * 1000 * 1000) / 1000, inrPerMsg: Math.round(costPer * USD_INR * 1000) / 1000,
    fieldAcc, byCat,
    errors: [...new Set(rs.filter((r) => r.error).map((r) => r.error))].slice(0, 3),
    failures: rs.filter((r) => !r.allOk).map((r) => ({ id: r.id, wrong: Object.entries(r.fields).filter(([, v]) => !v).map(([k]) => k).concat(r.medExpected !== undefined && r.medExpected !== r.medGot ? ["medical"] : [], r.emgExpected !== undefined && r.emgExpected !== r.emgGot ? ["emergency"] : []), got: r.got ? Object.fromEntries(Object.entries(r.got).filter(([k]) => ["intent", "date", "time", "forWhom", "profileRef", "visitType", "language"].includes(k))) : r.error })),
  };
}

async function main() {
  const args = parseArgs();
  const pool0 = args.set === "dev" ? CASES : args.set === "holdout" ? HOLDOUT : [...CASES, ...HOLDOUT];
  const cases = pool0.filter((c) => !args.only || c.id.startsWith(args.only) || c.cat === args.only);
  const runs: { label: string; fn: (c: EvalCase) => Promise<CaseResult> }[] = [
    ...args.models.map((m) => ({ label: m, fn: (c: EvalCase) => runSingle(m, c, args.timeoutMs) })),
    ...args.cascades.map(([p, e]) => ({ label: `${p} > ${e}`, fn: (c: EvalCase) => runCascade(p, e, c, Math.min(args.timeoutMs, 3500)) })),
  ];
  if (!runs.length) { console.error("Nothing to run. Use --models, --cascade, --all-economy or --all."); process.exit(1); }
  const outDir = join(here, "reports");
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const summaries = [];
  for (const run of runs) {
    const results: CaseResult[] = [];
    const work = Array.from({ length: args.repeat }, () => cases).flat();
    process.stderr.write(`▶ ${run.label} (${work.length} requests)… `);
    await pool(work, run.label === "rules" ? 1 : args.concurrency, async (c) => { results.push(await run.fn(c)); });
    const s = summarize(run.label, results);
    summaries.push(s);
    process.stderr.write(`all-fields ${s.allFieldsPct}% · critical ${s.criticalPct}% · medical recall ${s.medicalRecallPct}% · emergency recall ${s.emergencyRecallPct}% · p50 ${s.p50ms}ms · ₹${s.inrPerMsg}/msg\n`);
    writeFileSync(join(outDir, `${stamp}-${args.set}-${run.label.replace(/[^\w.-]+/g, "_")}.json`), JSON.stringify({ promptVersion: PROMPT_VERSION, summary: s, results }, null, 2));
  }
  const header = "| Model | Valid % | All-fields % | Critical % | Intent % | Medical recall % | Medical FP % | Emergency recall % | Emergency FP % | Escalated % | p50 ms | p95 ms | ₹/msg | $/1k msgs |";
  const rows = summaries.sort((a, b) => b.allFieldsPct - a.allFieldsPct).map((s) => `| ${s.model} | ${s.validPct} | ${s.allFieldsPct} | ${s.criticalPct} | ${s.intentPct} | ${s.medicalRecallPct} | ${s.medicalFalsePosPct} | ${s.emergencyRecallPct} | ${s.emergencyFalsePosPct} | ${s.escalatedPct ?? "–"} | ${s.p50ms} | ${s.p95ms} | ${s.inrPerMsg} | ${s.usdPer1kMsgs} |`);
  const md = [`# Extraction bake-off ${stamp}`, `Prompt ${PROMPT_VERSION} · set=${args.set} · ${cases.length} cases × ${args.repeat}`, "", header, "|" + "---|".repeat(15), ...rows].join("\n");
  writeFileSync(join(outDir, `${stamp}-${args.set}-summary.md`), md + "\n");
  console.log("\n" + md);
}

main().catch((e) => { console.error(e); process.exit(1); });
