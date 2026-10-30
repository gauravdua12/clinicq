"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, BASE } from "@/lib/api";
import { AdminShell } from "@/lib/Shell";
import { Logins, type LoginRow } from "@/lib/Logins";
import { STATUS_LABEL, WaPill, type ClinicRow } from "@/lib/AdminClinics";

// Admin portal → one customer clinic: who runs it, its number, its logins (fixed here when the clinic can't do it
// themselves), and its access: suspend, reactivate, archive, or delete for good. Its patients are never shown.

interface Detail extends ClinicRow { addressShort: string; phone: string; whatsappDetail: { connectedBy: string | null; connectedAt: string; checkedAt: string | null } | null; staff: LoginRow[] }
const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

export default function AdminClinic() {
  const [id, setId] = useState("");
  const [d, setD] = useState<Detail | null>(null);
  const [missing, setMissing] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setId(new URLSearchParams(window.location.search).get("id") ?? ""); }, []);
  const load = useCallback(async () => {
    if (!id) return;
    try { setD(await api<Detail>(`/api/admin/clinics/${encodeURIComponent(id)}`)); } catch (e) { if (e instanceof ApiError && e.status === 404) setMissing(true); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  const listLogins = useCallback(async () => (await api<Detail>(`/api/admin/clinics/${encodeURIComponent(id)}`)).staff, [id]);

  const setStatus = async (status: ClinicRow["status"], done: string) => {
    setBusy(true);
    try { await api(`/api/admin/clinics/${id}/status`, { body: { status } }); setMsg({ ok: true, text: done }); setRemoving(false); await load(); }
    catch { setMsg({ ok: false, text: "Couldn't change the clinic's access. Try again." }); }
    finally { setBusy(false); }
  };

  if (missing) return <AdminShell active="/admin"><div className="empty">This clinic isn&apos;t on Q-Incolo any more. <Link href="/admin">All clinics</Link></div></AdminShell>;
  if (!d) return <AdminShell active="/admin"><p className="muted">Loading…</p></AdminShell>;
  return (
    <AdminShell active="/admin" title={<Link href="/admin">← All clinics</Link>}>
      <div className="row" style={{ alignItems: "center", gap: 10 }}>
        <h1 style={{ margin: 0 }}>{d.name}</h1>
        <span className={`pill ${d.status === "ACTIVE" ? "mint" : "saffron"}`}>{STATUS_LABEL[d.status]}</span>
      </div>
      {d.status !== "ACTIVE" && d.statusChangedAt && <p className="small muted">{STATUS_LABEL[d.status]} since {day(d.statusChangedAt)}. Its logins can&apos;t sign in and Q-Incolo doesn&apos;t answer or message its patients.</p>}
      {msg && <div className={msg.ok ? "ok" : "err"} role="status" style={{ margin: "12px 0" }}>{msg.text}</div>}

      <div className="grid2" style={{ marginTop: 16 }}>
        <section className="card">
          <h2 style={{ marginTop: 0 }}>Clinic</h2>
          <dl className="wa-health">
            <dt>Doctor</dt><dd>{d.doctor}{d.doctorPhone ? ` · ${d.doctorPhone}` : ""}</dd>
            <dt>Clinic phone</dt><dd>{d.phone}</dd>
            <dt>Address</dt><dd>{d.addressShort}</dd>
            <dt>Clinic code</dt><dd>{d.code}</dd>
            <dt>Added</dt><dd>{day(d.createdAt)}</dd>
          </dl>
          <p className="small muted" style={{ marginBottom: 0 }}>Patients, bookings and the queue belong to the clinic and aren&apos;t shown to Incolo.</p>
        </section>
        <section className="card">
          <h2 style={{ marginTop: 0 }}>WhatsApp number</h2>
          <p style={{ marginTop: 0 }}><WaPill w={d.whatsapp} /> {d.whatsapp?.verifiedName && <b>{d.whatsapp.verifiedName}</b>}</p>
          {d.whatsappDetail && d.whatsapp?.status === "CONNECTED"
            ? <p className="small muted">Connected {day(d.whatsappDetail.connectedAt)}{d.whatsappDetail.connectedBy ? ` by ${d.whatsappDetail.connectedBy}` : ""}. The clinic manages it in Settings → WhatsApp.</p>
            : <p className="small muted">The doctor connects the clinic&apos;s number after signing in, in Settings → WhatsApp.</p>}
        </section>
      </div>

      <section className="card" style={{ marginTop: 16, maxWidth: 980 }}>
        <h2 style={{ marginTop: 0 }}>Logins</h2>
        <p className="small" style={{ marginTop: -4 }}>For when the clinic can&apos;t do it themselves, for example a doctor who lost their phone: add the new number as a doctor, then remove the old one. Changes here are recorded as Incolo&apos;s.</p>
        {id && <Logins list={listLogins} base={`/api/admin/clinics/${id}/staff`} canMakeDoctor onChange={() => void load()} />}
      </section>

      <section className="card" style={{ marginTop: 16, maxWidth: 980 }}>
        <h2 style={{ marginTop: 0 }}>Access</h2>
        {d.status === "ACTIVE" && <p className="small">Suspend pauses the clinic and can be undone at any time: its logins are signed out, and Q-Incolo stops answering and messaging its patients. Reminders due while it&apos;s suspended aren&apos;t sent.</p>}
        {d.status === "SUSPENDED" && <p className="small">Reactivating lets its logins sign in again and Q-Incolo answers on its number again.</p>}
        {d.status === "ARCHIVED" && <p className="small">Archived: the clinic left. Its data is kept and its number was disconnected. Reactivating lets its logins sign in; the doctor then connects the number again in Settings → WhatsApp.</p>}
        <div className="row">
          {d.status === "ACTIVE"
            ? <button disabled={busy} onClick={() => { if (confirm(`Suspend ${d.name}? Its logins are signed out and Q-Incolo stops answering its patients until you reactivate it.`)) void setStatus("SUSPENDED", `${d.name} is suspended.`); }}>Suspend</button>
            : <button className="primary" disabled={busy} onClick={() => void setStatus("ACTIVE", `${d.name} is active again.`)}>Reactivate</button>}
          <span className="spacer" />
          <button className="ghost warn" disabled={busy} onClick={() => { setRemoving(true); setConfirmName(""); setMsg(null); }}>Remove clinic…</button>
        </div>
      </section>

      {removing && (
        <div className="overlay" role="dialog" aria-modal="true" aria-label={`Remove ${d.name}`}>
          <div className="modal" style={{ maxWidth: 520, maxHeight: "calc(100vh - 32px)", overflowY: "auto" }}>
            <h2 style={{ marginTop: 0 }}>Remove {d.name}</h2>
            {d.status !== "ARCHIVED" && (
              <div className="picker-choice">
                <p style={{ margin: "0 0 4px" }}><b>Archive</b> <span className="pill mint">Recommended</span></p>
                <p className="small" style={{ marginTop: 0 }}>For a clinic that has left. Its logins stop, Q-Incolo stops answering, and its WhatsApp number is disconnected so they can use it elsewhere. Its data is kept, and you can reactivate it later.</p>
                <button className="primary" disabled={busy} onClick={() => void setStatus("ARCHIVED", `${d.name} is archived.`)}>Archive {d.name}</button>
              </div>
            )}
            <div className="picker-choice">
              <p style={{ margin: "0 0 4px" }}><b>Delete permanently</b></p>
              <p className="small" style={{ marginTop: 0 }}>Erases the clinic and everything in it: patients, bookings, queue, payments due, logins and its number&apos;s connection. This can&apos;t be undone. Type the clinic&apos;s name to confirm.</p>
              <label htmlFor="del-name">Clinic&apos;s name</label>
              <input id="del-name" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoComplete="off" />
              <button className="warn" style={{ marginTop: 10 }} disabled={busy || confirmName.trim() !== d.name.trim()} onClick={async () => {
                setBusy(true);
                try { await api(`/api/admin/clinics/${id}`, { method: "DELETE", body: { confirmName } }); window.location.href = `${BASE}/admin`; }
                catch { setMsg({ ok: false, text: "Couldn't delete the clinic. Try again." }); setRemoving(false); }
                finally { setBusy(false); }
              }}>Delete {d.name} permanently</button>
            </div>
            <button className="ghost" style={{ marginTop: 12, width: "100%" }} onClick={() => setRemoving(false)}>Cancel</button>
          </div>
        </div>
      )}
    </AdminShell>
  );
}
