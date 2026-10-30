"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";
import { ROLE_LABEL } from "./Shell";

// A clinic's logins: Settings → Staff (its doctor or clinic admin) and the admin portal's clinic page (Incolo, when a
// clinic can't do it themselves). The server enforces every rule; the buttons only hide what would be refused.

export interface LoginRow { id: string; name: string; role: "DOCTOR" | "CLINIC_ADMIN" | "STAFF"; onDuty: boolean; active: boolean; phone: string; you: boolean; incoloAdmin: boolean }

export const STAFF_ERR: Record<string, string> = {
  own_login: "You can't deactivate, remove or change the role of your own login.",
  incolo_admin: "This is an Incolo admin login. It can't be changed here.",
  last_doctor: "This is the clinic's only active doctor login. Add or activate another doctor first.",
  doctor_only: "Only a doctor can add, change or remove a doctor's login.",
  phone_in_use: "This WhatsApp number still signs in to another clinic. Ask that clinic to deactivate or remove it in Settings → Staff, then add it here.",
  not_found: "This login is no longer here. Refresh the page.",
};

export function Logins({ list, base, canMakeDoctor, onChange }: { list: () => Promise<LoginRow[]>; base: string; canMakeDoctor: boolean; onChange?: () => void }) {
  const [rows, setRows] = useState<LoginRow[]>([]);
  const [name, setName] = useState(""); const [phone, setPhone] = useState(""); const [role, setRole] = useState<LoginRow["role"]>("STAFF");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(() => list().then(setRows), [list]);
  useEffect(() => { void load(); }, [load]);
  const run = async <T,>(fn: () => Promise<T>, ok: string | ((r: T) => string), fail: string) => {
    try { const r = await fn(); setMsg({ ok: true, text: typeof ok === "function" ? ok(r) : ok }); } catch (e) { setMsg({ ok: false, text: (e instanceof ApiError && STAFF_ERR[e.code]) || fail }); }
    await load(); onChange?.();
  };
  const roles = (["DOCTOR", "CLINIC_ADMIN", "STAFF"] as const).filter((r) => canMakeDoctor || r !== "DOCTOR");
  return (
    <div>
      <p className="small muted" style={{ marginTop: 0 }}>Doctors and clinic admins manage the clinic: settings, hours, holidays, staff, WhatsApp and reports. A clinic admin can&apos;t add or change a doctor&apos;s login. Staff run the queue and bookings.</p>
      <div className="table-wrap"><table><thead><tr><th>Name</th><th>WhatsApp</th><th>Role</th><th>On duty</th><th /></tr></thead>
        <tbody>{rows.map((r) => {
          const editable = !r.you && !r.incoloAdmin && (canMakeDoctor || r.role !== "DOCTOR");
          return (
            <tr key={r.id} style={{ opacity: r.active ? 1 : 0.55 }}>
              <td>{r.name} {r.you && <span className="pill">You</span>} {r.incoloAdmin && <span className="pill blue">Incolo admin</span>} {!r.active && <span className="pill">Deactivated</span>}</td>
              <td>{r.phone}</td>
              <td>{editable
                ? <select aria-label={`Role of ${r.name}`} style={{ width: "auto", minHeight: 34 }} value={r.role} onChange={(e) => void run(() => api(`${base}/${r.id}`, { method: "PATCH", body: { role: e.target.value } }), `${r.name} is now ${ROLE_LABEL[e.target.value]}`, "Couldn't change the role. Try again.")}>
                    {roles.map((x) => <option key={x} value={x}>{ROLE_LABEL[x]}</option>)}
                  </select>
                : ROLE_LABEL[r.role]}</td>
              <td><input type="checkbox" aria-label={`${r.name} on duty`} style={{ width: "auto", minHeight: 0 }} checked={r.onDuty} onChange={(e) => void run(() => api(`${base}/${r.id}`, { method: "PATCH", body: { onDuty: e.target.checked } }), e.target.checked ? `${r.name} is on duty` : `${r.name} is off duty`, "Couldn't change this. Try again.")} /></td>
              <td style={{ whiteSpace: "nowrap" }}>{editable && <>
                <button className="ghost small" onClick={() => {
                  if (r.active && !confirm(`Deactivate ${r.name}? They won't be able to sign in until they're activated again.`)) return;
                  void run(() => api(`${base}/${r.id}`, { method: "PATCH", body: { active: !r.active } }), r.active ? `${r.name} deactivated` : `${r.name} activated`, "Couldn't change this login. Try again.");
                }}>{r.active ? "Deactivate" : "Activate"}</button>
                <button className="ghost small warn" style={{ marginLeft: 6 }} onClick={() => {
                  if (!confirm(`Remove ${r.name} permanently? Their login is deleted and they can't sign in. To give them access again, add them as new staff.`)) return;
                  void run(() => api(`${base}/${r.id}`, { method: "DELETE" }), `${r.name} removed`, "Couldn't remove this login. Try again.");
                }}>Remove</button>
              </>}</td>
            </tr>
          );
        })}</tbody></table></div>
      <h2 style={{ marginTop: 16 }}>Add a login</h2>
      <form className="row" onSubmit={(e) => {
        e.preventDefault();
        void run(async () => { const r = await api<{ moved?: boolean }>(base, { body: { name, phone, role } }); setName(""); setPhone(""); return r; },
          (r) => (r.moved ? "Added. Their login moved here from their previous clinic" : "Added"), "Check the name and 10-digit number.");
      }}>
        <input style={{ flex: 2, minWidth: 140 }} aria-label="Name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input style={{ flex: 2, minWidth: 140 }} aria-label="WhatsApp number" placeholder="WhatsApp number" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <select style={{ flex: 1, minWidth: 120 }} aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as LoginRow["role"])}>{roles.map((x) => <option key={x} value={x}>{ROLE_LABEL[x]}</option>)}</select>
        <button className="primary">Add</button>
      </form>
      {msg && <div className={msg.ok ? "ok" : "err"} role="status">{msg.text}</div>}
    </div>
  );
}
