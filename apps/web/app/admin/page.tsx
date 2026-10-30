"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { AdminShell } from "@/lib/Shell";
import { STATUS_LABEL, WaPill, type ClinicFilter as Filter, type ClinicRow } from "@/lib/AdminClinics";

// Admin portal → Clinics: every customer clinic (on its own WhatsApp number) and adding a new one. Who runs each clinic
// and its number, never its patients.

const ERR: Record<string, string> = {
  phone_in_use: "That WhatsApp number still signs in to a clinic on Q-Incolo (or is an Incolo login). That clinic deactivates or removes it first, then add the clinic again.",
  bad_phone: "Enter the doctor's 10-digit mobile number.",
  bad_request: "Fill in every field.",
};
const EMPTY = { clinicName: "", doctorName: "", doctorPhone: "", addressShort: "", clinicPhone: "" };

export default function AdminClinics() {
  const [rows, setRows] = useState<ClinicRow[] | null>(null);
  const [filter, setFilter] = useState<Filter>("ACTIVE");
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState(EMPTY);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { setRows(await api<ClinicRow[]>("/api/admin/clinics")); } catch { setRows([]); } }, []);
  useEffect(() => { void load(); }, [load]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => { setF({ ...f, [k]: e.target.value }); setMsg(null); };
  const shown = (rows ?? []).filter((r) => r.status === filter);
  const count = (s: Filter) => (rows ?? []).filter((r) => r.status === s).length;
  return (
    <AdminShell active="/admin" title="Customer clinics" actions={<button className="primary small" onClick={() => { setAdding(!adding); setMsg(null); }}>{adding ? "Close" : "+ Add clinic"}</button>}>
      <h1>Clinics</h1>
      {adding && (
        <section className="card" style={{ maxWidth: 860, marginBottom: 16 }}>
          <h2 style={{ marginTop: 0 }}>Add a customer clinic</h2>
          <p className="small muted" style={{ marginTop: -4 }}>After you add it, the doctor signs in at this site with their WhatsApp number, checks the hours, and connects the clinic&apos;s number in Settings → WhatsApp.</p>
          <form onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try { await api("/api/admin/clinics", { body: f }); setMsg({ ok: true, text: `${f.clinicName} added. ${f.doctorName} can now sign in with ${f.doctorPhone}.` }); setF(EMPTY); setFilter("ACTIVE"); await load(); }
            catch (er) { setMsg({ ok: false, text: (er instanceof ApiError && ERR[er.code]) || "Couldn't add the clinic. Check the fields." }); }
            finally { setBusy(false); }
          }}>
            <div className="row">
              <div style={{ flex: 1, minWidth: 200 }}><label htmlFor="cc-name">Clinic&apos;s name</label><input id="cc-name" required value={f.clinicName} onChange={set("clinicName")} placeholder="Sunrise Child Clinic" /></div>
              <div style={{ flex: 1, minWidth: 200 }}><label htmlFor="cc-doc">Doctor&apos;s name</label><input id="cc-doc" required value={f.doctorName} onChange={set("doctorName")} placeholder="Dr. Anil Mehta" /></div>
            </div>
            <div className="row">
              <div style={{ flex: 1, minWidth: 200 }}><label htmlFor="cc-wa">Doctor&apos;s WhatsApp (for sign-in)</label><input id="cc-wa" required inputMode="tel" value={f.doctorPhone} onChange={set("doctorPhone")} placeholder="98765 43210" /></div>
              <div style={{ flex: 1, minWidth: 200 }}><label htmlFor="cc-ph">Clinic phone (shown to patients)</label><input id="cc-ph" required inputMode="tel" value={f.clinicPhone} onChange={set("clinicPhone")} placeholder="+91 20 4000 5555" /></div>
            </div>
            <label htmlFor="cc-addr">Short address</label><input id="cc-addr" required value={f.addressShort} onChange={set("addressShort")} placeholder="Baner, Pune" />
            <button className="primary" style={{ marginTop: 12 }} disabled={busy}>Add clinic</button>
          </form>
        </section>
      )}
      {msg && <div className={msg.ok ? "ok" : "err"} role="status" style={{ marginBottom: 12 }}>{msg.text}</div>}
      <div className="tabs">{(["ACTIVE", "SUSPENDED", "ARCHIVED"] as Filter[]).map((s) => <button key={s} className={filter === s ? "active" : ""} onClick={() => setFilter(s)}>{STATUS_LABEL[s]} ({count(s)})</button>)}</div>
      {rows === null ? <p className="muted">Loading…</p> : !shown.length ? (
        <div className="empty">{filter === "ACTIVE" ? "No customer clinics yet. Add one with + Add clinic." : `No ${STATUS_LABEL[filter].toLowerCase()} clinics.`}</div>
      ) : (
        <div className="card" style={{ maxWidth: 980, padding: "4px 16px" }}>
          <ul className="rem-list" style={{ margin: 0 }}>{shown.map((r) => (
            <li key={r.id} className="rem-row" style={{ borderTop: 0, borderBottom: "1px solid var(--line)" }}>
              <div className="rem-main">
                <Link href={`/admin/clinic?id=${r.id}`}><b>{r.name}</b></Link>
                <div className="small muted">{r.doctor}{r.doctorPhone ? ` · ${r.doctorPhone}` : ""} · {r.logins} login{r.logins === 1 ? "" : "s"} · added {new Date(r.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</div>
              </div>
              <div className="rem-amt"><WaPill w={r.whatsapp} /></div>
            </li>
          ))}</ul>
        </div>
      )}
    </AdminShell>
  );
}
