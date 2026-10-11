"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Shell } from "@/lib/Shell";

interface Appt { id: string; date: string; time: string; token: string | null; status: string; visitType: string | null; source: string; name: string; phone: string | null }
interface SlotRow { sessionLabel: string; startMin: number; time: string; status: string }

const todayIST = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const addDays = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const label = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

export default function Appointments() {
  const [today, setToday] = useState(todayIST());
  const [date, setDate] = useState(todayIST());
  useEffect(() => { api<{ today: string }>("/api/clinic").then((c) => { setToday(c.today); setDate(c.today); }).catch(() => undefined); }, []);
  const [rows, setRows] = useState<Appt[]>([]);
  const [slots, setSlots] = useState<SlotRow[]>([]);
  const [book, setBook] = useState<SlotRow | null>(null);
  const days = useMemo(() => Array.from({ length: 8 }, (_, i) => addDays(today, i)), [today]);

  const load = useCallback(async () => {
    setRows(await api<Appt[]>(`/api/appointments?from=${date}&to=${date}`));
    setSlots(await api<SlotRow[]>(`/api/slots?date=${date}`));
  }, [date]);
  useEffect(() => { void load(); }, [load]);

  const byTime = new Map(rows.filter((r) => ["BOOKED", "ARRIVED", "COMPLETED", "NO_SHOW"].includes(r.status)).map((r) => [r.time, r]));

  return (
    <Shell active="/appointments">
      <h1>Appointments</h1>
      <div className="tabs">{days.map((d) => <button key={d} className={d === date ? "active" : ""} onClick={() => setDate(d)}>{label(d)}</button>)}</div>
      <div className="card">
        {slots.length === 0 && <div className="empty">Clinic closed on this day</div>}
        <table>
          <thead><tr><th>Time</th><th>Patient</th><th>Token</th><th>Status</th><th /></tr></thead>
          <tbody>
            {slots.map((s) => {
              const a = byTime.get(s.time);
              return (
                <tr key={s.startMin}>
                  <td>{s.time}<div className="small muted">{s.sessionLabel}</div></td>
                  <td>{a ? <>{a.name}<div className="small muted">{a.phone ?? "—"} · {a.visitType?.replace("_", " ").toLowerCase() ?? ""}</div></> : <span className="muted">{s.status === "blocked" ? "Blocked" : s.status === "ok" ? "Free" : s.status === "taken" ? "Held" : "—"}</span>}</td>
                  <td>{a?.token ?? ""}</td>
                  <td>{a && <span className={`pill ${a.status === "NO_SHOW" ? "saffron" : a.status === "BOOKED" ? "blue" : "mint"}`}>{a.status.replace("_", " ").toLowerCase()}</span>}</td>
                  <td className="row" style={{ justifyContent: "flex-end" }}>
                    {a?.status === "BOOKED" && date === today && <button className="small" onClick={async () => { await api(`/api/appointments/${a.id}/arrive`, { body: {} }); void load(); }}>Arrived</button>}
                    {a?.status === "BOOKED" && <button className="small warn" onClick={async () => { if (confirm(`Cancel ${a.name}'s appointment? They'll be told on WhatsApp.`)) { await api(`/api/appointments/${a.id}/cancel`, { body: {} }); void load(); } }}>Cancel</button>}
                    {!a && s.status === "ok" && <button className="small" onClick={() => setBook(s)}>Book</button>}
                    {!a && (s.status === "ok" || s.status === "blocked") && <button className="small ghost" onClick={async () => { await api("/api/slots/block", { body: { date, startMin: s.startMin, blocked: s.status !== "blocked" } }); void load(); }}>{s.status === "blocked" ? "Unblock" : "Block"}</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {book && <BookModal date={date} slot={book} onClose={() => setBook(null)} onDone={() => { setBook(null); void load(); }} />}
    </Shell>
  );
}

function BookModal({ date, slot, onClose, onDone }: { date: string; slot: SlotRow; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [visitType, setVisitType] = useState("NEW");
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Book {label(date)}, {slot.time}</h2>
        <p className="small muted">For a patient who called. They'll get the confirmation on WhatsApp.</p>
        <label htmlFor="bn">Patient name</label><input id="bn" value={name} onChange={(e) => { setName(e.target.value); setErr(null); }} autoFocus />
        <label htmlFor="bp">WhatsApp number</label><input id="bp" value={phone} onChange={(e) => { setPhone(e.target.value); setErr(null); }} inputMode="tel" placeholder="98765 43210" />
        <label htmlFor="bv">Visit type</label>
        <select id="bv" value={visitType} onChange={(e) => setVisitType(e.target.value)}><option value="NEW">New consultation</option><option value="FOLLOW_UP">Follow-up</option><option value="REPORT_SHOW">Show reports</option></select>
        {err && <div className="err">{err}</div>}
        <div className="row" style={{ marginTop: 14, justifyContent: "flex-end" }}>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" onClick={async () => {
            if (!name.trim()) return setErr("Enter the patient's name.");
            if (!/\d{10}/.test(phone.replace(/\D/g, ""))) return setErr("Enter a 10-digit mobile number.");
            try { await api("/api/appointments", { body: { name: name.trim(), phone, date, startMin: slot.startMin, visitType } }); onDone(); }
            catch (e) { setErr(e instanceof ApiError && e.code.startsWith("slot") ? "That slot was just taken." : "Couldn't book. Try again."); }
          }}>Book</button>
        </div>
      </div>
    </div>
  );
}
