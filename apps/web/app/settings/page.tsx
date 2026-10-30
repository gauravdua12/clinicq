"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError, BASE } from "@/lib/api";
import { Shell } from "@/lib/Shell";
import { WhatsAppTab } from "@/lib/WhatsAppConnect";
import { Logins, type LoginRow } from "@/lib/Logins";

type Tab = "clinic" | "sessions" | "closures" | "staff" | "whatsapp" | "qr";
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function Settings() {
  const [tab, setTab] = useState<Tab>("clinic");
  // Everything a clinic needs. Incolo's own settings (language model, clinics, demos) are in the admin portal.
  const [ownNumber, setOwnNumber] = useState(false);
  useEffect(() => { api<{ ownNumber?: boolean }>("/api/clinic").then((c) => setOwnNumber(!!c?.ownNumber)).catch(() => undefined); }, []);
  const tabs: [Tab, string][] = [["clinic", "Clinic"], ["sessions", "Sessions"], ["closures", "Holidays & leave"], ["staff", "Staff"], ...(ownNumber ? [["whatsapp", "WhatsApp"] as [Tab, string]] : []), ["qr", "Walk-in QR & TV"]];
  return (
    <Shell active="/settings">
      <h1>Settings</h1>
      <div className="tabs">{tabs.map(([k, l]) => <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{l}</button>)}</div>
      {tab === "clinic" && <ClinicTab />}
      {tab === "sessions" && <SessionsTab />}
      {tab === "closures" && <ClosuresTab />}
      {tab === "staff" && <StaffTab />}
      {tab === "whatsapp" && ownNumber && <WhatsAppTab />}
      {tab === "qr" && <QrTab />}
    </Shell>
  );
}

function useSaved() {
  const [state, setState] = useState<{ ok?: string; err?: string }>({});
  return { state, ok: (m = "Saved") => setState({ ok: m }), err: (m: string) => setState({ err: m }), clear: () => setState({}) };
}

interface ClinicData { name: string; addressShort: string; addressFull: string; mapsUrl: string | null; phone: string; doctorName: string; qualification: string | null; settings: Record<string, unknown> & { fees?: string; windowDays?: number; cutoffMinutes?: number; walkinOverflowTimeoutMinutes?: number; turnNearThreshold?: number; flowsEnabled?: boolean; slotPicker?: "page" | "chat"; followUp?: { remindDaysBefore: number }; paymentReminders?: PayCfg } }
interface PayCfg { upiId: string; payeeName: string; remindEveryDays: number; maxReminders: number }
const PAY_DEFAULT: PayCfg = { upiId: "", payeeName: "", remindEveryDays: 3, maxReminders: 2 };

function ClinicTab() {
  const [d, setD] = useState<ClinicData | null>(null);
  const s = useSaved();
  useEffect(() => { api<ClinicData>("/api/settings/clinic").then(setD); }, []);
  if (!d) return <p className="muted">Loading…</p>;
  const set = (k: keyof ClinicData, v: unknown) => { setD({ ...d, [k]: v } as ClinicData); s.clear(); };
  const setS = (k: string, v: unknown) => { setD({ ...d, settings: { ...d.settings, [k]: v } }); s.clear(); };
  return (
    <div className="card" style={{ maxWidth: 640 }}>
      <label>Clinic name</label><input value={d.name} onChange={(e) => set("name", e.target.value)} />
      <label>Doctor display name</label><input value={d.doctorName} onChange={(e) => set("doctorName", e.target.value)} />
      <label>Qualification line</label><input value={d.qualification ?? ""} onChange={(e) => set("qualification", e.target.value)} />
      <label>Short address (shown in confirmations)</label><input value={d.addressShort} onChange={(e) => set("addressShort", e.target.value)} />
      <label>Full address</label><input value={d.addressFull} onChange={(e) => set("addressFull", e.target.value)} />
      <label>Google Maps link</label><input value={d.mapsUrl ?? ""} onChange={(e) => set("mapsUrl", e.target.value || null)} />
      <label>Clinic phone (shown to patients)</label><input value={d.phone} onChange={(e) => set("phone", e.target.value)} />
      <label>Fees text</label><input value={d.settings.fees ?? ""} onChange={(e) => setS("fees", e.target.value)} placeholder="₹600 (follow-up within 7 days ₹300)" />
      <div className="row" style={{ marginTop: 6 }}>
        <div style={{ flex: 1 }}><label>Book up to (days ahead)</label><input type="number" value={d.settings.windowDays ?? 7} onChange={(e) => setS("windowDays", Number(e.target.value))} /></div>
        <div style={{ flex: 1 }}><label>Booking cut-off (minutes before)</label><input type="number" value={d.settings.cutoffMinutes ?? 60} onChange={(e) => setS("cutoffMinutes", Number(e.target.value))} /></div>
      </div>
      <div className="row">
        <div style={{ flex: 1 }}><label>Walk-in staff reply timeout (min)</label><input type="number" value={d.settings.walkinOverflowTimeoutMinutes ?? 5} onChange={(e) => setS("walkinOverflowTimeoutMinutes", Number(e.target.value))} /></div>
        <div style={{ flex: 1 }}><label>"Turn near" alert when ahead ≤</label><input type="number" value={d.settings.turnNearThreshold ?? 2} onChange={(e) => setS("turnNearThreshold", Number(e.target.value))} /></div>
      </div>
      <fieldset className="picker-choice">
        <legend>How patients pick a time</legend>
        <label><input type="radio" name="slotPicker" checked={(d.settings.slotPicker ?? "page") === "page"} onChange={() => setS("slotPicker", "page")} />
          <span><b>Booking page</b><br /><span className="small muted">A "Choose date &amp; time" button opens one screen: swipe through dates and Morning / Evening slots, then confirm.</span></span></label>
        <label><input type="radio" name="slotPicker" checked={d.settings.slotPicker === "chat"} onChange={() => setS("slotPicker", "chat")} />
          <span><b>In the chat</b><br /><span className="small muted">The bot suggests the nearest times as buttons; "See all slots" lists Morning or Evening times.</span></span></label>
        <p className="small muted" style={{ margin: "6px 0 0" }}>Either way, a patient can just type a time, and nothing is booked before they confirm.</p>
      </fieldset>
      <fieldset className="picker-choice">
        <legend>Follow-up and payment reminders</legend>
        <label htmlFor="fu-days" style={{ display: "block" }}>Remind about a follow-up visit (days before it's due)</label>
        <input id="fu-days" type="number" min={0} max={14} value={d.settings.followUp?.remindDaysBefore ?? 2} onChange={(e) => setS("followUp", { remindDaysBefore: Number(e.target.value) })} />
        <label htmlFor="upi" style={{ display: "block" }}>UPI ID for online payments</label>
        <input id="upi" value={(d.settings.paymentReminders ?? PAY_DEFAULT).upiId} placeholder="clinicname@okicici" onChange={(e) => setS("paymentReminders", { ...PAY_DEFAULT, ...d.settings.paymentReminders, upiId: e.target.value.trim() })} />
        <label htmlFor="payee" style={{ display: "block" }}>Name shown in the UPI app</label>
        <input id="payee" value={(d.settings.paymentReminders ?? PAY_DEFAULT).payeeName} placeholder={d.name} onChange={(e) => setS("paymentReminders", { ...PAY_DEFAULT, ...d.settings.paymentReminders, payeeName: e.target.value })} />
        <div className="row">
          <div style={{ flex: 1 }}><label htmlFor="pay-every">Remind again every (days)</label><input id="pay-every" type="number" min={1} max={30} value={(d.settings.paymentReminders ?? PAY_DEFAULT).remindEveryDays} onChange={(e) => setS("paymentReminders", { ...PAY_DEFAULT, ...d.settings.paymentReminders, remindEveryDays: Number(e.target.value) })} /></div>
          <div style={{ flex: 1 }}><label htmlFor="pay-max">Reminders after the first message</label><input id="pay-max" type="number" min={0} max={5} value={(d.settings.paymentReminders ?? PAY_DEFAULT).maxReminders} onChange={(e) => setS("paymentReminders", { ...PAY_DEFAULT, ...d.settings.paymentReminders, maxReminders: Number(e.target.value) })} /></div>
        </div>
        <p className="small muted" style={{ margin: "6px 0 0" }}>Payment reminders need the UPI ID: patients get a "Pay now" button that opens your UPI details and QR code. Patients can also pay at the clinic.</p>
      </fieldset>
      <button className="primary" style={{ marginTop: 14 }} onClick={async () => {
        try { await api("/api/settings/clinic", { method: "PUT", body: { name: d.name, addressShort: d.addressShort, addressFull: d.addressFull, mapsUrl: d.mapsUrl, phone: d.phone, doctorName: d.doctorName, qualification: d.qualification, settings: d.settings } }); s.ok(); }
        catch { s.err("Couldn't save. Check the fields."); }
      }}>Save</button>
      {s.state.ok && <div className="ok">{s.state.ok}</div>}{s.state.err && <div className="err">{s.state.err}</div>}
    </div>
  );
}

interface Sess { weekday: number; label: string; startTime: string; endTime: string; slotMinutes: number; maxSlots?: number | null; walkinQuota: number; active?: boolean }

const mins = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
/** Slots a session shows patients: as many slot lengths as fit, or exactly the number set. */
const slotCount = (r: Sess) => { const fit = Math.max(0, Math.floor((mins(r.endTime) - mins(r.startTime)) / Math.max(1, r.slotMinutes))); return r.maxSlots ? Math.min(r.maxSlots, fit) : fit; };

function SessionsTab() {
  const [rows, setRows] = useState<Sess[]>([]);
  const s = useSaved();
  useEffect(() => { api<Sess[]>("/api/settings/sessions").then((r) => setRows(r.filter((x) => x.active !== false))); }, []);
  const upd = (i: number, k: keyof Sess, v: string | number) => {
    setRows(rows.map((r, j) => {
      if (j !== i) return r;
      const next = { ...r, [k]: v } as Sess;
      if (k === "slotMinutes") next.maxSlots = null; // slot length set directly: show every slot that fits
      if (k === "startTime" || k === "endTime") { if (next.maxSlots) next.slotMinutes = Math.max(1, Math.floor((mins(next.endTime) - mins(next.startTime)) / next.maxSlots)); }
      return next;
    }));
    s.clear();
  };
  // "Slots" typed: the slot length follows from the hours, and exactly that many slots are shown.
  const setSlots = (i: number, n: number) => {
    setRows(rows.map((r, j) => (j === i ? { ...r, maxSlots: n > 0 ? n : null, slotMinutes: n > 0 ? Math.max(1, Math.floor((mins(r.endTime) - mins(r.startTime)) / n)) : r.slotMinutes } : r)));
    s.clear();
  };
  return (
    <div className="card">
      <p className="small muted">Each row is one weekly session. Set the hours, then either the <b>number of slots</b> you want patients to see (the slot length is worked out for you) or the <b>slot length</b>.</p>
      <div className="table-scroll"><table className="sess-table">
        <thead><tr><th>Day</th><th>Label</th><th>Start</th><th>End</th><th>Slots</th><th>Slot (min)</th><th>Walk-in quota</th><th /></tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={i}>
            <td><select value={r.weekday} onChange={(e) => upd(i, "weekday", Number(e.target.value))}>{WD.map((w, k) => <option key={k} value={k}>{w}</option>)}</select></td>
            <td><input value={r.label} onChange={(e) => upd(i, "label", e.target.value)} /></td>
            <td><input type="time" value={r.startTime} onChange={(e) => upd(i, "startTime", e.target.value)} /></td>
            <td><input type="time" value={r.endTime} onChange={(e) => upd(i, "endTime", e.target.value)} /></td>
            <td><input type="number" min={1} max={300} aria-label="Number of slots" value={slotCount(r)} onChange={(e) => setSlots(i, Number(e.target.value))} />
              <div className="small muted nowrap">{slotCount(r) ? `ends ${hhmm(mins(r.startTime) + slotCount(r) * r.slotMinutes)}` : "no slots"}</div></td>
            <td><input type="number" min={1} max={120} aria-label="Slot length in minutes" value={r.slotMinutes} onChange={(e) => upd(i, "slotMinutes", Number(e.target.value))} /></td>
            <td><input type="number" value={r.walkinQuota} onChange={(e) => upd(i, "walkinQuota", Number(e.target.value))} /></td>
            <td><button className="ghost warn" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button></td>
          </tr>
        ))}</tbody>
      </table></div>
      <div className="row" style={{ marginTop: 10 }}>
        <button onClick={() => setRows([...rows, { weekday: 1, label: "Morning", startTime: "10:00", endTime: "13:00", slotMinutes: 15, walkinQuota: 10 }])}>+ Add session</button>
        <button className="primary" onClick={async () => {
          try { await api("/api/settings/sessions", { method: "PUT", body: rows.map(({ weekday, label, startTime, endTime, slotMinutes, maxSlots, walkinQuota }) => ({ weekday, label, startTime, endTime, slotMinutes, maxSlots: maxSlots ?? null, walkinQuota })) }); s.ok(); }
          catch (e) { s.err(e instanceof ApiError && e.code === "overlap" ? "Two sessions on the same day overlap." : e instanceof ApiError && e.code === "end_before_start" ? "End time must be after start time." : "Couldn't save."); }
        }}>Save sessions</button>
      </div>
      {s.state.ok && <div className="ok">{s.state.ok}</div>}{s.state.err && <div className="err">{s.state.err}</div>}
    </div>
  );
}

function ClosuresTab() {
  const [rows, setRows] = useState<{ id: string; date: string; sessionId: string | null; label: string | null }[]>([]);
  const [date, setDate] = useState("");
  const [labelText, setLabel] = useState("Holiday");
  const [pending, setPending] = useState<number | null>(null);
  const s = useSaved();
  const load = useCallback(() => api<typeof rows>("/api/settings/closures").then(setRows), []);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="card" style={{ maxWidth: 640 }}>
      <div className="row">
        <div style={{ flex: 1 }}><label>Date</label><input type="date" value={date} onChange={(e) => { setDate(e.target.value); setPending(null); }} /></div>
        <div style={{ flex: 1 }}><label>Reason (shown to staff only)</label><input value={labelText} onChange={(e) => setLabel(e.target.value)} /></div>
      </div>
      {pending === null ? (
        <button style={{ marginTop: 10 }} onClick={async () => { if (!date) return s.err("Pick a date."); const r = await api<{ affectedAppointments: number }>("/api/settings/closures", { body: { date, label: labelText } }); setPending(r.affectedAppointments); }}>Close this day</button>
      ) : (
        <div className="banner" style={{ marginTop: 10 }}>
          {pending ? `${pending} appointment(s) on this day will be cancelled and each patient told on WhatsApp.` : "No appointments on this day."}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" onClick={async () => { await api("/api/settings/closures", { body: { date, label: labelText, confirm: true } }); setPending(null); setDate(""); s.ok("Day closed"); void load(); }}>Confirm closure</button>
            <button className="ghost" onClick={() => setPending(null)}>Back</button>
          </div>
        </div>
      )}
      {s.state.ok && <div className="ok">{s.state.ok}</div>}{s.state.err && <div className="err">{s.state.err}</div>}
      <h2 style={{ marginTop: 18 }}>Upcoming closures</h2>
      {rows.length === 0 && <p className="muted small">None</p>}
      {rows.map((r) => <div key={r.id} className="row" style={{ justifyContent: "space-between", borderBottom: "1px solid var(--line)", padding: "6px 0" }}><span>{r.date.slice(0, 10)} · {r.label ?? "Closed"}{r.sessionId ? " (one session)" : ""}</span><button className="ghost warn" onClick={async () => { await api(`/api/settings/closures/${r.id}`, { method: "DELETE" }); void load(); }}>Remove</button></div>)}
    </div>
  );
}

function StaffTab() {
  const [me, setMe] = useState<{ role: string } | null>(null);
  useEffect(() => { api<{ role: string }>("/api/me").then(setMe).catch(() => undefined); }, []);
  const list = useCallback(() => api<LoginRow[]>("/api/settings/staff"), []);
  if (!me) return <p className="muted">Loading…</p>;
  return <div className="card" style={{ maxWidth: 820 }}><Logins list={list} base="/api/settings/staff" canMakeDoctor={me.role === "DOCTOR"} /></div>;
}

function QrTab() {
  const [qr, setQr] = useState<{ text: string; url: string; png: string } | null>(null);
  const [key, setKey] = useState<string | null>(null);
  useEffect(() => { api<typeof qr>("/api/settings/qr").then(setQr); api<{ key: string }>("/api/settings/display-key").then((r) => setKey(r.key)).catch(() => undefined); }, []);
  return (
    <div className="row" style={{ alignItems: "flex-start" }}>
      <div className="card" style={{ maxWidth: 360 }}>
        <h2>Today's walk-in QR</h2>
        <p className="small muted">Print or show at reception. The code changes every midnight so nobody can join the queue from home.</p>
        {qr && <><img src={qr.png} alt="Walk-in QR code" style={{ width: "100%", background: "#fff", borderRadius: 8 }} /><p className="small">Message: <code>{qr.text}</code></p><button onClick={() => window.print()}>Print</button></>}
      </div>
      {key && <div className="card" style={{ maxWidth: 360 }}>
        <h2>Waiting-room TV</h2>
        <p className="small muted">Open this link on the TV browser in full screen. It shows tokens only (first names if enabled).</p>
        <a href={`${BASE}/display?key=${encodeURIComponent(key)}`} target="_blank">Open display</a>
      </div>}
    </div>
  );
}
