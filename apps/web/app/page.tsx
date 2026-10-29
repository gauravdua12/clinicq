"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError, fmtClock, subscribe, type EntryView, type QueueSnapshot } from "@/lib/api";
import { Shell } from "@/lib/Shell";
import { Stub } from "@/lib/Stub";
import { FollowUpModal, PaymentModal } from "@/lib/Reminders";

interface Overflow { id: string; name: string; expiresAt: string }

const metaFor = (e: EntryView, withEta = true, demo = false) => [
  e.source === "A" ? `Booked ${fmtClock(e.slotStart)}` : `Walk-in · ${fmtClock(e.arrivedAt)}`,
  e.expectedAt ? `given ${fmtClock(e.expectedAt)}` : null,
  e.lateArrival ? "came late" : null,
  withEta && e.etaMin != null ? `~${Math.max(5, Math.round(e.etaMin / 5) * 5)} min` : null,
  e.hasWhatsApp || demo ? null : "no WhatsApp",
].filter(Boolean).join(" · ");

export default function QueueBoard() {
  const [snap, setSnap] = useState<QueueSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [overflow, setOverflow] = useState<Overflow[]>([]);
  const [callbacks, setCallbacks] = useState<string[]>([]);
  const [loadErr, setLoadErr] = useState(false);
  // The patient whose consultation was just completed: offer a follow-up date or a payment due (FU-01).
  const [justSeen, setJustSeen] = useState<{ id: string; name: string } | null>(null);
  const [visitAct, setVisitAct] = useState<"fu" | "pay" | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!justSeen || visitAct) return;
    const t = setTimeout(() => setJustSeen(null), 60_000);
    return () => clearTimeout(t);
  }, [justSeen, visitAct]);

  const load = useCallback(async () => {
    try {
      const [s, o] = await Promise.all([api<QueueSnapshot>("/api/queue/today"), api<Overflow[]>("/api/overflow/pending")]);
      setSnap(s); setOverflow(o); setLoadErr(false);
    } catch { setLoadErr(true); }
  }, []);
  useEffect(() => {
    if (!loadErr) return;
    const t = setTimeout(load, 3000);
    return () => clearTimeout(t);
  }, [loadErr, load]);

  useEffect(() => {
    void load();
    const off = subscribe("/api/events", (type, data) => {
      if (["queue.updated", "doctor.status", "overflow.requested", "overflow.resolved", "appointment.changed"].includes(type)) void load();
      if (type === "payment.claimed") { const d = data as { name: string; amount: string }; setCallbacks((c) => [...c, `${d.name} says they've paid ₹${d.amount}. Check and mark it paid in Appointments → Follow-ups & payments.`]); }
      if (type === "callback.requested") setCallbacks((c) => [...c, `${(data as { name: string }).name} (${(data as { maskedPhone: string }).maskedPhone}) asked for a call back`]);
    });
    const t = setInterval(load, 30_000);
    return () => { off(); clearInterval(t); };
  }, [load]);

  const act = async (path: string, body: unknown = {}) => {
    setBusy(true); setMsg(null);
    const seen = path === "/api/queue/advance" && snap?.inConsult?.hasWhatsApp ? { id: snap.inConsult.id, name: snap.inConsult.name } : null;
    try {
      const r = await api<QueueSnapshot | { informed: number }>(path, { body });
      if (r && "waiting" in r) setSnap(r); else await load();
      if (seen) { setJustSeen(seen); setNotice(null); }
    } catch (e) {
      setMsg(e instanceof ApiError && e.code === "STALE" ? "Someone else just updated the board. It has been refreshed." : "That didn't go through. Try again.");
      await load();
    } finally { setBusy(false); }
  };

  if (!snap) return <Shell active="/">{loadErr ? <div className="err">Couldn't load the queue. Retrying in a few seconds… Check the internet connection if this continues.</div> : <p className="muted">Loading the queue…</p>}</Shell>;
  const canPrimary = !!snap.inConsult || !!snap.next || snap.waiting.length > 0;
  const title = snap.session ? `${snap.session.label} session · ${fmtTime(snap.session.startTime)}–${fmtTime(snap.session.endTime)}` : "No session today";

  return (
    <Shell active="/" title={title} actions={<><span className="livepill">Live</span><DoctorStatus onAct={act} delay={snap.delayMin} paused={!!snap.pauseUntil} /></>}>
      {(snap.delayMin > 0 || snap.pauseUntil) && (
        <div className="banner">{snap.pauseUntil ? `Doctor is on a break until ${fmtClock(snap.pauseUntil)}. Waiting patients were told.` : `Doctor is running ${snap.delayMin} min late. Patients were told their new times.`}</div>
      )}
      {callbacks.map((c, i) => (
        <div key={i} className="banner"><span style={{ flex: 1 }}>{c}</span><button className="ghost" onClick={() => setCallbacks((x) => x.filter((_, j) => j !== i))}>Dismiss</button></div>
      ))}
      {msg && <div className="err" style={{ marginBottom: 12 }}>{msg}</div>}
      {justSeen && (
        <div className="banner" role="status">
          <span style={{ flex: 1 }}>{justSeen.name}&apos;s consultation is done.</span>
          <button onClick={() => setVisitAct("fu")}>Set follow-up</button>
          <button onClick={() => setVisitAct("pay")}>Payment due</button>
          <button className="ghost" aria-label="Dismiss" onClick={() => setJustSeen(null)}>×</button>
        </div>
      )}
      {notice && <div className={notice.ok ? "ok" : "err"} role="status" style={{ marginBottom: 12, display: "flex", justifyContent: "space-between", gap: 10 }}><span>{notice.text}</span><button className="ghost small" style={{ padding: 0 }} aria-label="Dismiss" onClick={() => setNotice(null)}>×</button></div>}
      {loadErr && <div className="err" style={{ marginBottom: 12 }}>Connection lost. Showing the last known queue; retrying…</div>}

      <div className="board">
        <section className="now">
          <div>
            <div className="lane-title"><span className="eyebrow">In consultation</span></div>
            {snap.inConsult ? <Stub big kind="consult" token={snap.inConsult.token} name={snap.inConsult.name} meta={metaFor(snap.inConsult, false, snap.demo)} /> : <div className="empty">Cabin is free</div>}
          </div>
          <button className="go big" disabled={busy || !canPrimary} onClick={() => act("/api/queue/advance", { expectInConsult: snap.inConsult?.id ?? null })}>
            {snap.inConsult ? "✓  Consultation completed" : "Send next patient in"}
          </button>
          <div>
            <div className="lane-title"><span className="eyebrow">Next</span>{snap.next && <span className="small muted">Told to be ready</span>}</div>
            {snap.next
              ? <Stub kind="next" token={snap.next.token} name={snap.next.name} meta={metaFor(snap.next, false, snap.demo)} actions={<button className="small" disabled={busy} onClick={() => act(`/api/queue/${snap.next!.id}/no-show`, { version: snap.next!.version })}>Not here</button>} />
              : <div className="empty">Nobody lined up</div>}
          </div>
          <div className="kpis">
            <div className="kpi"><div className="v">{snap.counts.booked}</div><div className="l">Booked</div></div>
            <div className="kpi"><div className="v">{snap.counts.walkins}</div><div className="l">Walk-ins</div></div>
            <div className="kpi"><div className="v">{snap.counts.completed}</div><div className="l">Seen</div></div>
            <div className="kpi"><div className="v">{snap.avgConsultMin}<span className="small muted"> min</span></div><div className="l">Avg consult</div></div>
          </div>
        </section>

        <section className="card">
          <div className="section-head">
            <h2 style={{ margin: 0 }}>Waiting <span className="muted" style={{ fontWeight: 500 }}>{snap.waiting.length}</span></h2>
            <button className="primary" onClick={() => setAddOpen(true)}>+ Add walk-in</button>
          </div>
          {snap.waiting.length === 0 && <div className="empty">Nobody waiting. Walk-ins who scan the reception QR code appear here.</div>}
          {snap.waiting.map((e, i) => (
            <Stub key={e.id} token={e.token} name={e.name} meta={metaFor(e, true, snap.demo)} actions={<>
              <button className="ghost icon" aria-label={`Move ${e.token} up`} disabled={busy || i === 0} onClick={() => act(`/api/queue/${e.id}/move`, { direction: "up" })}>▲</button>
              <button className="ghost icon" aria-label={`Move ${e.token} down`} disabled={busy || i === snap.waiting.length - 1} onClick={() => act(`/api/queue/${e.id}/move`, { direction: "down" })}>▼</button>
              <button className="ghost icon" aria-label={`Remove ${e.token}`} disabled={busy} onClick={() => confirm(`Remove ${e.token} ${e.name} from the queue?`) && act(`/api/queue/${e.id}/cancel`, { version: e.version })}>✕</button>
            </>} />
          ))}
        </section>
      </div>

      {justSeen && visitAct === "fu" && <FollowUpModal visit={{ queueEntryId: justSeen.id }} name={justSeen.name} onClose={() => setVisitAct(null)} onDone={(text) => { setVisitAct(null); setJustSeen(null); setNotice({ ok: true, text }); }} />}
      {justSeen && visitAct === "pay" && <PaymentModal visit={{ queueEntryId: justSeen.id }} name={justSeen.name} onClose={() => setVisitAct(null)} onDone={(text, ok) => { setVisitAct(null); setJustSeen(null); setNotice({ ok, text }); }} />}
      {addOpen && <AddWalkin onClose={() => setAddOpen(false)} onDone={(s) => { setSnap(s); setAddOpen(false); }} />}
      {overflow[0] && <OverflowPopup req={overflow[0]} onDone={load} />}
    </Shell>
  );
}

function fmtTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

function DoctorStatus({ onAct, delay, paused }: { onAct: (p: string, b: unknown) => Promise<void>; delay: number; paused: boolean }) {
  const [open, setOpen] = useState(false);
  const [min, setMin] = useState(15);
  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open}>Doctor status ▾</button>
      {open && (
        <div className="card" style={{ position: "absolute", right: 0, top: 46, width: 280, zIndex: 20 }}>
          <label htmlFor="ds-min" style={{ marginTop: 0 }}>Minutes</label>
          <input id="ds-min" type="number" min={0} max={240} value={min} onChange={(e) => setMin(Number(e.target.value))} />
          <div className="row" style={{ marginTop: 10 }}>
            <button onClick={() => { void onAct("/api/queue/broadcast", { type: "late", minutes: min }); setOpen(false); }}>Running late</button>
            <button onClick={() => { void onAct("/api/queue/broadcast", { type: "pause", minutes: min }); setOpen(false); }}>Short break</button>
          </div>
          {(paused || delay > 0) && <button className="go" style={{ marginTop: 10, width: "100%" }} onClick={() => { void onAct("/api/queue/broadcast", { type: "resume" }); void onAct("/api/queue/broadcast", { type: "late", minutes: 0 }); setOpen(false); }}>Back on time</button>}
          <p className="small muted" style={{ marginBottom: 0 }}>Waiting and booked patients get a WhatsApp update.</p>
        </div>
      )}
    </div>
  );
}

function AddWalkin({ onClose, onDone }: { onClose: () => void; onDone: (s: QueueSnapshot) => void }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="overlay" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return setErr("Enter the patient's name.");
        if (phone.trim() && !/\d{10}/.test(phone.replace(/\D/g, ""))) return setErr("Enter a 10-digit mobile number, or leave it empty.");
        setBusy(true);
        try { onDone(await api<QueueSnapshot>("/api/queue/walkin", { body: { name: name.trim(), phone: phone.trim() || undefined } })); }
        catch (er) { setErr(er instanceof ApiError && er.code === "no_session" ? "No session is running right now." : "Couldn't add the patient. Try again."); }
        finally { setBusy(false); }
      }}>
        <h2>Add walk-in</h2>
        <label htmlFor="wn">Patient name</label>
        <input id="wn" value={name} onChange={(e) => { setName(e.target.value); setErr(null); }} placeholder="Anil Verma" autoFocus />
        <label htmlFor="wp">WhatsApp number <span className="muted" style={{ fontWeight: 400 }}>(optional, for turn alerts)</span></label>
        <input id="wp" value={phone} onChange={(e) => { setPhone(e.target.value); setErr(null); }} placeholder="98765 43210" inputMode="tel" />
        {err && <div className="err">{err}</div>}
        <div className="row" style={{ marginTop: 16, justifyContent: "flex-end" }}>
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy}>Add to queue</button>
        </div>
      </form>
    </div>
  );
}

function OverflowPopup({ req, onDone }: { req: Overflow; onDone: () => void }) {
  const [stage, setStage] = useState<"ask" | "time">("ask");
  const [time, setTime] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const decide = async (body: unknown) => {
    try { await api(`/api/overflow/${req.id}/decide`, { body }); }
    catch (e) { setErr(e instanceof ApiError && e.code === "already_handled" ? "Someone already handled this." : "Couldn't save. Try again."); }
    onDone();
  };
  return (
    <div className="overlay">
      <div className="modal" role="dialog" aria-labelledby="ovf-title">
        <span className="pill saffron">Walk-in list is full</span>
        <h2 id="ovf-title" style={{ marginTop: 10 }}>{req.name} is at reception</h2>
        {stage === "ask" ? (
          <>
            <p className="muted">Can the doctor see this patient today?</p>
            <div className="row"><button className="primary" onClick={() => setStage("time")}>Yes, fit them in</button><button onClick={() => decide({ decision: "no" })}>No, offer a booking</button></div>
          </>
        ) : (
          <>
            <label htmlFor="ot">Time to give the patient</label>
            <input id="ot" type="time" value={time} onChange={(e) => { setTime(e.target.value); setErr(null); }} />
            <div className="row" style={{ marginTop: 12 }}>
              <button className="primary" onClick={() => (time ? decide({ decision: "yes", time }) : setErr("Pick a time, or add them at the end of the queue."))}>Give this time</button>
              <button onClick={() => decide({ decision: "yes", endOfQueue: true })}>End of queue</button>
            </div>
          </>
        )}
        {err && <div className="err">{err}</div>}
        <p className="small muted" style={{ marginTop: 12 }}>If nobody answers by {fmtClock(req.expiresAt)}, the patient is offered booking times automatically.</p>
      </div>
    </div>
  );
}
