"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "./api";

// Incolo admin portal → Language model: which model reads patients' free text and voice notes (docs/MODEL_SELECTION.md).

interface CatalogModel { spec: string; label: string; openWeight: boolean; residency: string; inPerM: number | null; outPerM: number | null; tier: string }
interface AiCfg { primary: string; escalation: string; minConfidence: number; timeoutMs: number; stt: string; sttFallback: string }
interface Smoke { passed: number; total: number; safetyMisses: string[]; failures: string[]; avgMs: number }

export function ModelSettings() {
  const [cfg, setCfg] = useState<AiCfg | null>(null);
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok?: boolean; reason?: string; smoke?: Smoke } | null>(null);
  useEffect(() => { api<{ config: AiCfg; catalog: CatalogModel[] }>("/api/admin/ai").then((r) => { setCfg(r.config); setCatalog(r.catalog); }); }, []);
  if (!cfg) return <p className="muted">Loading…</p>;
  const opt = (m: CatalogModel) => <option key={m.spec} value={m.spec}>{m.label} · {m.residency === "in" ? "India" : m.residency} · ${m.inPerM}/${m.outPerM} per M</option>;
  return (
    <div className="card" style={{ maxWidth: 720 }}>
      <p className="small muted">Understands patients' free-text and voice messages (booking details only). The primary model handles every message; when it is unsure, the failover model double-checks. Before a change is saved, a live test of 12 messages runs; it must catch every emergency and health-detail case.</p>
      <label>Primary model (every message)</label>
      <select value={cfg.primary} onChange={(e) => { setCfg({ ...cfg, primary: e.target.value }); setResult(null); }}>
        <option value="rules">Built-in rules only (no AI)</option>
        {catalog.map(opt)}
      </select>
      <label>Failover model (when the primary is unsure or fails)</label>
      <select value={cfg.escalation} onChange={(e) => { setCfg({ ...cfg, escalation: e.target.value }); setResult(null); }}>
        <option value="">None</option>
        {catalog.map(opt)}
      </select>
      <label>Custom model spec (optional, e.g. openai-compat:qwen3-32b for a self-hosted server)</label>
      <input placeholder="leave empty to use the selections above" onBlur={(e) => e.target.value && setCfg({ ...cfg, primary: e.target.value })} />
      <div className="row">
        <div style={{ flex: 1 }}><label>Failover when confidence below</label><input type="number" step="0.05" min={0} max={1} value={cfg.minConfidence} onChange={(e) => setCfg({ ...cfg, minConfidence: Number(e.target.value) })} /></div>
        <div style={{ flex: 1 }}><label>Timeout (ms)</label><input type="number" value={cfg.timeoutMs} onChange={(e) => setCfg({ ...cfg, timeoutMs: Number(e.target.value) })} /></div>
      </div>
      <label>Voice notes (speech-to-text)</label>
      <select value={cfg.stt} onChange={(e) => setCfg({ ...cfg, stt: e.target.value })}>
        <option value="voxtral-small">Voxtral Small 24B (Bedrock, India)</option><option value="voxtral-mini">Voxtral Mini 3B (Bedrock, India)</option><option value="transcribe">Amazon Transcribe (India)</option><option value="sarvam">Sarvam AI</option><option value="openai-compat">Self-hosted Whisper</option><option value="mock">Simulator (dev)</option>
      </select>
      <button className="primary" style={{ marginTop: 14 }} disabled={saving} onClick={async () => {
        setSaving(true); setResult(null);
        try { const r = await api<{ saved: boolean; smoke?: Smoke }>("/api/admin/ai", { method: "PUT", body: cfg }); setResult({ ok: r.saved, smoke: r.smoke }); }
        catch (e) { const b = (e as ApiError).body as { reason?: string; smoke?: Smoke }; setResult({ ok: false, reason: b?.reason, smoke: b?.smoke }); }
        finally { setSaving(false); }
      }}>{saving ? "Testing the model…" : "Test & save"}</button>
      {result?.ok && <div className="ok">Saved. Live test: {result.smoke ? `${result.smoke.passed}/${result.smoke.total} passed, avg ${result.smoke.avgMs} ms` : "skipped"}.</div>}
      {result && !result.ok && <div className="err">Not saved{result.reason === "smoke_failed" && result.smoke ? `: live test ${result.smoke.passed}/${result.smoke.total}${result.smoke.safetyMisses.length ? `, missed safety cases ${result.smoke.safetyMisses.join(", ")}` : ""}.` : result.reason ? `: ${result.reason}` : "."}</div>}
    </div>
  );
}
