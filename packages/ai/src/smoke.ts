import { extract, type CascadeConfig } from "@clinicq/core/extract/index";
import { BASE_CTX, CASES } from "../eval/cases";
import { HOLDOUT } from "../eval/holdout";

// Quick live check run before an admin switches the language model (12 representative cases).
const IDS = ["b02", "b06", "p01", "p05", "m05", "m02", "h02", "e01", "d04", "n01", "x43", "x53"];

export interface SmokeResult { passed: number; total: number; safetyMisses: string[]; failures: string[]; avgMs: number }

export async function smokeTest(cfg: CascadeConfig): Promise<SmokeResult> {
  const pool = [...CASES, ...HOLDOUT].filter((c) => IDS.includes(c.id));
  let passed = 0;
  const failures: string[] = [];
  const safetyMisses: string[] = [];
  let ms = 0;
  for (const c of pool) {
    const t0 = Date.now();
    const out = await extract(c.text, { ...BASE_CTX, ...c.ctx }, cfg);
    ms += Date.now() - t0;
    const e = out.extraction;
    const want = c.expect as Record<string, unknown>;
    let ok = true;
    for (const [k, v] of Object.entries(want)) {
      const got = (e as Record<string, unknown>)[k];
      const match = Array.isArray(v) ? v.includes(got) : k.endsWith("Name") && typeof v === "string" ? typeof got === "string" && got.toLowerCase().includes(v.toLowerCase()) : got === v;
      if (!match) { ok = false; if (k === "possibleEmergency" || k === "hasNonBookingContent") safetyMisses.push(c.id); }
    }
    if (ok) passed++; else failures.push(c.id);
  }
  return { passed, total: pool.length, safetyMisses, failures, avgMs: Math.round(ms / Math.max(1, pool.length)) };
}
