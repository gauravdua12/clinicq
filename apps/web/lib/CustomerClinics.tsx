"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";

// Incolo admins: clinics that run on their own WhatsApp number. Create one with the doctor's WhatsApp number; the doctor
// then signs in, sets the clinic's hours and connects the number in Settings → WhatsApp.

interface Row { id: string; name: string; doctor: string; doctorPhone: string; createdAt: string; whatsapp: { status: string; displayPhone: string | null; verifiedName: string | null } | null }

const ERR: Record<string, string> = {
  phone_in_use: "That WhatsApp number already signs in to a clinic on Q-Incolo.",
  bad_phone: "Enter the doctor's 10-digit mobile number.",
  bad_request: "Fill in every field.",
};

export function CustomerClinics() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [f, setF] = useState({ clinicName: "", doctorName: "", doctorPhone: "", addressShort: "", clinicPhone: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { setRows(await api<Row[]>("/api/admin/clinics")); } catch { setRows([]); } }, []);
  useEffect(() => { void load(); }, [load]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => { setF({ ...f, [k]: e.target.value }); setMsg(null); };
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <h2 style={{ marginTop: 0 }}>Customer clinics</h2>
      <p className="small muted" style={{ marginTop: -4 }}>Clinics on their own WhatsApp number. After you add one, the doctor signs in at this site with their WhatsApp number, checks the hours, and connects the clinic&apos;s number in Settings → WhatsApp.</p>
      <form onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try { await api("/api/admin/clinics", { body: f }); setMsg({ ok: true, text: `${f.clinicName} added. ${f.doctorName} can now sign in with ${f.doctorPhone}.` }); setF({ clinicName: "", doctorName: "", doctorPhone: "", addressShort: "", clinicPhone: "" }); await load(); }
        catch (er) { setMsg({ ok: false, text: (er instanceof ApiError && ERR[er.code]) || "Couldn't add the clinic. Check the fields." }); }
        finally { setBusy(false); }
      }}>
        <div className="row">
          <div style={{ flex: 1, minWidth: 200 }}><label htmlFor="cc-name">Customer clinic&apos;s name</label><input id="cc-name" required value={f.clinicName} onChange={set("clinicName")} placeholder="Sunrise Child Clinic" /></div>
          <div style={{ flex: 1, minWidth: 200 }}><label htmlFor="cc-doc">Doctor&apos;s name</label><input id="cc-doc" required value={f.doctorName} onChange={set("doctorName")} placeholder="Dr. Anil Mehta" /></div>
        </div>
        <div className="row">
          <div style={{ flex: 1, minWidth: 200 }}><label htmlFor="cc-wa">Doctor&apos;s WhatsApp (for sign-in)</label><input id="cc-wa" required inputMode="tel" value={f.doctorPhone} onChange={set("doctorPhone")} placeholder="98765 43210" /></div>
          <div style={{ flex: 1, minWidth: 200 }}><label htmlFor="cc-ph">Clinic phone (shown to patients)</label><input id="cc-ph" required inputMode="tel" value={f.clinicPhone} onChange={set("clinicPhone")} placeholder="+91 20 4000 5555" /></div>
        </div>
        <label htmlFor="cc-addr">Short address</label><input id="cc-addr" required value={f.addressShort} onChange={set("addressShort")} placeholder="Baner, Pune" />
        {msg && <div className={msg.ok ? "ok" : "err"} role="status">{msg.text}</div>}
        <button className="primary" style={{ marginTop: 12 }} disabled={busy}>Add customer clinic</button>
      </form>
      {rows && !!rows.length && <ul className="rem-list" style={{ marginTop: 16 }}>{rows.map((r) => (
        <li key={r.id} className="rem-row">
          <div className="rem-main"><b>{r.name}</b> <span className="small muted">{r.doctor} · {r.doctorPhone}</span></div>
          <div className="rem-amt">{r.whatsapp?.status === "CONNECTED"
            ? <span className="pill mint">{r.whatsapp.displayPhone ?? "Connected"}</span>
            : <span className="pill">{r.whatsapp ? "Disconnected" : "Number not connected"}</span>}</div>
        </li>
      ))}</ul>}
    </section>
  );
}
