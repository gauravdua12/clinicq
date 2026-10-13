"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Shell } from "@/lib/Shell";

interface R { from: string; to: string; byDay: Record<string, { booked: number; walkins: number; completed: number; noShow: number }>; peakHours: Record<string, number>; avgWaitMin: number | null; noShowRate: number | null }

export default function Reports() {
  const [r, setR] = useState<R | null>(null);
  useEffect(() => { api<R>("/api/reports/summary").then(setR); }, []);
  if (!r) return <Shell active="/reports"><p className="muted">Loading…</p></Shell>;
  const days = Object.entries(r.byDay).sort(([a], [b]) => a.localeCompare(b));
  const max = Math.max(1, ...days.map(([, v]) => v.booked + v.walkins));
  const tot = days.reduce((a, [, v]) => ({ booked: a.booked + v.booked, walkins: a.walkins + v.walkins, completed: a.completed + v.completed }), { booked: 0, walkins: 0, completed: 0 });
  const peak = Object.entries(r.peakHours).sort(([, a], [, b]) => b - a)[0];
  return (
    <Shell active="/reports">
      <h1>Last 30 days</h1>
      <p className="small muted">Visit counts and waiting times only. No clinical information is recorded.</p>
      <div className="row" style={{ margin: "12px 0" }}>
        {[["Booked", tot.booked], ["Walk-ins", tot.walkins], ["Completed", tot.completed], ["No-show rate", r.noShowRate == null ? "—" : `${r.noShowRate}%`], ["Avg wait", r.avgWaitMin == null ? "—" : `${r.avgWaitMin} min`], ["Busiest hour", peak ? `${Number(peak[0]) % 12 || 12} ${Number(peak[0]) >= 12 ? "PM" : "AM"}` : "—"]].map(([l, v]) => (
          <div key={String(l)} className="card" style={{ minWidth: 140 }}><div className="small muted">{l}</div><div style={{ fontSize: 24, fontWeight: 700 }}>{v}</div></div>
        ))}
      </div>
      <div className="card">
        <h2>Daily footfall</h2>
        {days.length === 0 && <p className="muted">No visits yet.</p>}
        {days.map(([d, v]) => (
          <div key={d} className="row" style={{ gap: 10, margin: "4px 0" }}>
            <span className="small" style={{ width: 90 }}>{d.slice(5)}</span>
            <div style={{ flex: 1, display: "flex", height: 16 }}>
              <div title={`Booked ${v.booked}`} style={{ width: `${(100 * v.booked) / max}%`, background: "var(--mint)", borderRadius: "4px 0 0 4px" }} />
              <div title={`Walk-ins ${v.walkins}`} style={{ width: `${(100 * v.walkins) / max}%`, background: "var(--saffron)", borderRadius: "0 4px 4px 0", marginLeft: 2 }} />
            </div>
            <span className="small muted" style={{ width: 90 }}>{v.booked} + {v.walkins}</span>
          </div>
        ))}
        <p className="small muted">Green: booked · Amber: walk-ins</p>
      </div>
    </Shell>
  );
}
