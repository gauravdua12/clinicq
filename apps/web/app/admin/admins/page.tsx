"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { AdminShell } from "@/lib/Shell";

// Admin portal → Incolo admins. Owners come from the server's configuration and can't be removed here; nobody can
// switch off or remove their own admin login.

interface AdminRow { id: string; name: string; phone: string; owner: boolean; active: boolean; you: boolean; createdAt: string }
const ERR: Record<string, string> = {
  bad_phone: "Enter a 10-digit mobile number.",
  bad_request: "Enter a name and a 10-digit mobile number.",
  phone_in_use: "That number signs in to a customer clinic. Incolo admins use their own numbers.",
  own_login: "You can't switch off or remove your own admin login.",
  owner: "Owners are set in the server's configuration and can't be changed here.",
};

export default function AdminAdmins() {
  const [rows, setRows] = useState<AdminRow[]>([]);
  const [name, setName] = useState(""); const [phone, setPhone] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(() => api<AdminRow[]>("/api/admin/admins").then(setRows).catch(() => undefined), []);
  useEffect(() => { void load(); }, [load]);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); setMsg({ ok: true, text: ok }); } catch (e) { setMsg({ ok: false, text: (e instanceof ApiError && ERR[e.code]) || "Couldn't do that. Try again." }); }
    await load();
  };
  return (
    <AdminShell active="/admin/admins" title="Who can use this admin portal">
      <h1>Incolo admins</h1>
      <div className="card" style={{ maxWidth: 820 }}>
        <p className="small muted" style={{ marginTop: 0 }}>Admins add and manage clinics, fix a clinic&apos;s logins, run demos and choose the language model. They never see a clinic&apos;s patients. Each admin signs in with their own WhatsApp number.</p>
        <div className="table-wrap"><table><thead><tr><th>Name</th><th>WhatsApp</th><th>Added</th><th /></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id} style={{ opacity: r.active ? 1 : 0.55 }}>
              <td>{r.name} {r.you && <span className="pill">You</span>} {r.owner && <span className="pill blue">Owner</span>} {!r.active && <span className="pill">Switched off</span>}</td>
              <td>{r.phone}</td>
              <td>{new Date(r.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</td>
              <td style={{ whiteSpace: "nowrap" }}>{!r.owner && !r.you && <>
                <button className="ghost small" onClick={() => {
                  if (r.active && !confirm(`Switch off ${r.name}? They're signed out and can't use the admin portal until switched on again.`)) return;
                  void run(() => api(`/api/admin/admins/${r.id}`, { method: "PATCH", body: { active: !r.active } }), r.active ? `${r.name} switched off` : `${r.name} switched on`);
                }}>{r.active ? "Switch off" : "Switch on"}</button>
                <button className="ghost small warn" style={{ marginLeft: 6 }} onClick={() => {
                  if (!confirm(`Remove ${r.name} as an Incolo admin? Their login is deleted.`)) return;
                  void run(() => api(`/api/admin/admins/${r.id}`, { method: "DELETE" }), `${r.name} removed`);
                }}>Remove</button>
              </>}</td>
            </tr>
          ))}</tbody></table></div>
        <h2 style={{ marginTop: 16 }}>Add an admin</h2>
        <form className="row" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api("/api/admin/admins", { body: { name, phone } }); setName(""); setPhone(""); }, "Added. They can sign in at this site with their WhatsApp number."); }}>
          <input style={{ flex: 2, minWidth: 140 }} aria-label="Name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <input style={{ flex: 2, minWidth: 140 }} aria-label="WhatsApp number" placeholder="WhatsApp number" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <button className="primary">Add admin</button>
        </form>
        {msg && <div className={msg.ok ? "ok" : "err"} role="status">{msg.text}</div>}
      </div>
    </AdminShell>
  );
}
