"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";

// "Set follow-up" and "Payment due" for one visit (an appointment or a queue token). Date and amount only: no reasons.

export type VisitRef = { appointmentId: string } | { queueEntryId: string };

const todayIST = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const addDays = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export const fmtDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

const ERR: Record<string, string> = {
  no_whatsapp: "This patient isn't on WhatsApp with the clinic, so they can't be reminded.",
  bad_date: "Pick a date after today, within a year.",
  no_upi: "Add the clinic's UPI ID first: Settings → Clinic → Follow-up and payment reminders.",
  not_found: "That visit couldn't be found. Refresh and try again.",
};
const errText = (e: unknown) => (e instanceof ApiError && ERR[e.code]) || "Couldn't save. Try again.";

export function FollowUpModal({ visit, name, onClose, onDone }: { visit: VisitRef; name: string; onClose: () => void; onDone: (text: string) => void }) {
  const today = todayIST();
  const [date, setDate] = useState(addDays(today, 7));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const picks: [string, number][] = [["1 week", 7], ["2 weeks", 14], ["1 month", 30], ["3 months", 90]];
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" role="dialog" aria-labelledby="fu-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="fu-title">Follow-up for {name}</h2>
        <p className="small muted">They'll get a WhatsApp reminder a couple of days before, with a button to book.</p>
        <div className="row" role="group" aria-label="Follow-up after">
          {picks.map(([l, n]) => <button key={n} className={date === addDays(today, n) ? "primary" : ""} onClick={() => { setDate(addDays(today, n)); setErr(null); }}>{l}</button>)}
        </div>
        <label htmlFor="fu-date">Follow-up date</label>
        <input id="fu-date" type="date" min={addDays(today, 1)} value={date} onChange={(e) => { setDate(e.target.value); setErr(null); }} />
        {err && <div className="err">{err}</div>}
        <div className="row" style={{ marginTop: 14, justifyContent: "flex-end" }}>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy} onClick={async () => {
            setBusy(true);
            try { const r = await api<{ remindOn: string }>("/api/followups", { body: { ...visit, dueDate: date } }); onDone(`Follow-up set for ${name} on ${fmtDay(date)}. Reminder goes on ${fmtDay(r.remindOn)}.`); }
            catch (e) { setErr(errText(e)); } finally { setBusy(false); }
          }}>Set follow-up</button>
        </div>
      </div>
    </div>
  );
}

export function PaymentModal({ visit, name, onClose, onDone }: { visit: VisitRef; name: string; onClose: () => void; onDone: (text: string, ok: boolean) => void }) {
  const [amount, setAmount] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="overlay" onClick={onClose}>
      <form className="modal" role="dialog" aria-labelledby="pay-title" onClick={(e) => e.stopPropagation()} onSubmit={async (e) => {
        e.preventDefault();
        const n = Number(amount.replace(/[,₹\s]/g, ""));
        if (!(n > 0)) return setErr("Enter the amount due, in rupees.");
        setBusy(true);
        try {
          const r = await api<{ whatsappSent: boolean }>("/api/payments", { body: { ...visit, amount: n } });
          onDone(r.whatsappSent ? `Payment reminder for ₹${n.toLocaleString("en-IN")} sent to ${name} on WhatsApp.` : `Saved ₹${n.toLocaleString("en-IN")} due from ${name}, but WhatsApp couldn't deliver the message. Please tell the patient directly.`, r.whatsappSent);
        } catch (er) { setErr(errText(er)); } finally { setBusy(false); }
      }}>
        <h2 id="pay-title">Payment due from {name}</h2>
        <p className="small muted">They'll get a WhatsApp message with the amount and a "Pay now" button (UPI), then a reminder every few days until it's marked paid.</p>
        <label htmlFor="pay-amt">Amount due (₹)</label>
        <input id="pay-amt" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); setErr(null); }} placeholder="500" autoFocus />
        {err && <div className="err">{err}</div>}
        <div className="row" style={{ marginTop: 14, justifyContent: "flex-end" }}>
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy}>Send reminder</button>
        </div>
      </form>
    </div>
  );
}

interface FollowUpRow { id: string; name: string; phone: string; dueDate: string; status: "scheduled" | "reminded" | "booked" }
interface PaymentRow { id: string; name: string; phone: string; visitDate: string; amount: number; status: string; remindersSent: number; claimedPaid: boolean }

/** Follow-ups coming up, and amounts due (with Mark paid / Remind / Cancel). */
export function RemindersPanel({ refreshKey, onNotice }: { refreshKey: number; onNotice: (n: { ok: boolean; text: string }) => void }) {
  const [fus, setFus] = useState<FollowUpRow[] | null>(null);
  const [pays, setPays] = useState<PaymentRow[] | null>(null);
  const load = useCallback(async () => {
    const [f, p] = await Promise.all([api<FollowUpRow[]>("/api/followups"), api<{ rows: PaymentRow[] }>("/api/payments")]);
    setFus(f); setPays(p.rows);
  }, []);
  useEffect(() => { void load().catch(() => undefined); }, [load, refreshKey]);
  const act = async (path: string, done: string, body: object = {}, method?: string) => {
    try { const r = await api<{ whatsappSent?: boolean }>(path, { body, method }); onNotice({ ok: r?.whatsappSent !== false, text: r?.whatsappSent === false ? `${done} WhatsApp couldn't deliver the message.` : done }); }
    catch (e) { onNotice({ ok: false, text: e instanceof ApiError && e.code === "too_soon" ? "A reminder already went out in the last 12 hours." : "That didn't go through. Try again." }); }
    await load();
  };
  const pending = (pays ?? []).filter((p) => p.status === "PENDING");
  const upcoming = (fus ?? []).filter((f) => f.status !== "booked" || f.dueDate >= todayIST());
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Payments due <span className="muted" style={{ fontWeight: 500 }}>{pending.length}</span></h2>
      {pays && !pending.length && <div className="empty">Nothing pending. Use "Payment due" on a patient's visit to send them a reminder.</div>}
      {!!pending.length && <ul className="rem-list">{pending.map((p) => (
        <li key={p.id} className="rem-row">
          <div className="rem-main">
            <b>{p.name}</b> <span className="small muted">{p.phone}</span>
            <div className="small muted">Visit {fmtDay(p.visitDate)} · {p.remindersSent} {p.remindersSent === 1 ? "message" : "messages"} sent</div>
          </div>
          <div className="rem-amt">₹{p.amount.toLocaleString("en-IN")}{p.claimedPaid && <div><span className="pill mint">Patient says paid</span></div>}</div>
          <div className="rem-acts">
            <button className="small" onClick={() => act(`/api/payments/${p.id}/paid`, `Marked ₹${p.amount.toLocaleString("en-IN")} from ${p.name} as paid. A receipt was sent on WhatsApp.`)}>Mark paid</button>
            {!p.claimedPaid && <button className="small ghost" onClick={() => act(`/api/payments/${p.id}/remind`, `Reminder sent to ${p.name}.`)}>Remind now</button>}
            <button className="small ghost warn" onClick={() => confirm(`Cancel the ₹${p.amount} due from ${p.name}? No more reminders will go out.`) && act(`/api/payments/${p.id}/cancel`, "Payment reminder cancelled.")}>Cancel</button>
          </div>
        </li>
      ))}</ul>}

      <h2>Follow-ups <span className="muted" style={{ fontWeight: 500 }}>{upcoming.length}</span></h2>
      {fus && !upcoming.length && <div className="empty">No follow-ups set. Use "Follow-up" on a patient's visit, or on the queue board after the consultation.</div>}
      {!!upcoming.length && <ul className="rem-list">{upcoming.map((f) => (
        <li key={f.id} className="rem-row">
          <div className="rem-main">
            <b>{f.name}</b> <span className="small muted">{f.phone}</span>
            <div className="small muted">Due {fmtDay(f.dueDate)}</div>
          </div>
          <div className="rem-amt"><span className={`pill ${f.status === "booked" ? "mint" : f.status === "reminded" ? "blue" : ""}`}>{f.status === "booked" ? "Booked" : f.status === "reminded" ? "Reminded" : "Reminder scheduled"}</span></div>
          <div className="rem-acts">
            {f.status !== "booked" && <button className="small ghost warn" onClick={() => confirm(`Cancel ${f.name}'s follow-up reminder?`) && act(`/api/followups/${f.id}`, "Follow-up cancelled.", undefined, "DELETE")}>Cancel</button>}
          </div>
        </li>
      ))}</ul>}
    </div>
  );
}
