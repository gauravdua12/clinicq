"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError, BASE } from "@/lib/api";
import { Shell } from "@/lib/Shell";

interface Session { days: number[]; label: string; start: string; end: string }
interface Profile { clinicName: string; doctorName: string; qualification: string | null; specialty: string | null; addressShort: string; addressFull: string; phone: string | null; mapsUrl: string | null; fees: string | null; sessions: Session[] }
interface DemoRow { id: string; name: string; isDemo: boolean; active: boolean; doctor: string; addressShort: string; createdAt: string }
interface Kit { clinicName: string; doctor: string; waNumber: string; chatUrl: string; chatQr: string; walkinText: string; walkinQr: string; dashboardUrl: string; displayUrl: string }

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const daysText = (d: number[]) => (d.length === 6 && !d.includes(0) ? "Mon–Sat" : d.length === 7 ? "Every day" : d.map((x) => WD[x]).join(", "));
const prettyNum = (n: string) => (n.length === 12 ? `+${n.slice(0, 2)} ${n.slice(2, 7)} ${n.slice(7)}` : n);

export default function DemoStudio() {
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [details, setDetails] = useState("");
  const [doctorName, setDoctorName] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "read" | "create">("");
  const [err, setErr] = useState<string | null>(null);
  const [demos, setDemos] = useState<DemoRow[]>([]);
  const [kit, setKit] = useState<Kit | null>(null);
  const [off, setOff] = useState(false);

  const load = useCallback(async () => {
    try { setDemos(await api<DemoRow[]>("/api/demo")); setKit(await api<Kit>("/api/demo/kit")); }
    catch (e) { if (e instanceof ApiError && e.status === 404) setOff(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const input = () => ({ name: name.trim(), website: website.trim(), details: details.trim() || undefined, doctorName: doctorName.trim() || undefined, specialty: specialty.trim() || undefined });

  if (off) return <Shell active="/demo"><div className="empty">Demo Studio is turned off on this server (DEMO_STUDIO=false).</div></Shell>;

  return (
    <Shell active="/demo" title="Show Q-Incolo to a prospect in two minutes">
      <div className="grid2" style={{ alignItems: "start" }}>
        <section className="card">
          <h2>New demo</h2>
          <p className="small muted" style={{ marginTop: -4 }}>Only public details are needed. Website text and brochures are read by AI to fill the clinic profile; you can edit everything before creating.</p>
          <label htmlFor="d-name">Clinic name</label>
          <input id="d-name" value={name} onChange={(e) => { setName(e.target.value); setErr(null); }} placeholder="Mehta Bone & Joint Clinic" />
          <label htmlFor="d-web">Website <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label>
          <input id="d-web" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="mehtaortho.in" inputMode="url" />
          <label htmlFor="d-det">Details from a brochure, Google listing or visiting card <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label>
          <textarea id="d-det" value={details} onChange={(e) => setDetails(e.target.value)} placeholder={"Dr. Rajesh Mehta, MS (Ortho)\nOPD: Mon–Sat 10–1:30, 6–9 pm\nAndheri West, Mumbai · 022 2671 4455"} />
          <div className="row">
            <div style={{ flex: 1, minWidth: 160 }}><label htmlFor="d-doc">Doctor name <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label><input id="d-doc" value={doctorName} onChange={(e) => setDoctorName(e.target.value)} placeholder="Dr. R. Mehta" /></div>
            <div style={{ flex: 1, minWidth: 160 }}><label htmlFor="d-spec">Specialty <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label><input id="d-spec" value={specialty} onChange={(e) => setSpecialty(e.target.value)} placeholder="Orthopaedics" /></div>
          </div>
          {err && <div className="err">{err}</div>}
          {note && <div className="ok">{note}</div>}
          <div className="row" style={{ marginTop: 14 }}>
            <button disabled={!!busy} onClick={async () => {
              if (name.trim().length < 2) return setErr("Enter the clinic name.");
              if (!website.trim() && !details.trim()) return setErr("Add a website or paste some details to read — or create the demo directly with default timings.");
              setBusy("read"); setErr(null); setNote(null);
              try {
                const r = await api<{ profile: Profile | null; usedModel: string | null; websiteError?: string; sourceChars: number }>("/api/demo/preview", { body: input() });
                setProfile(r.profile);
                setNote(r.websiteError ? `Couldn't read the website (${r.websiteError}). Used the pasted details only.` : r.usedModel ? `Read ${r.sourceChars.toLocaleString("en-IN")} characters. Check the profile below.` : "No AI model is configured, so defaults were used.");
              } catch { setErr("Couldn't read the details. Try again, or create with defaults."); } finally { setBusy(""); }
            }}>{busy === "read" ? "Reading…" : "Read details"}</button>
            <button className="primary" disabled={!!busy} onClick={async () => {
              if (name.trim().length < 2) return setErr("Enter the clinic name.");
              setBusy("create"); setErr(null);
              try {
                await api("/api/demo", { body: { input: input(), profile: profile ?? undefined } });
                setNote("Demo created and switched on. The WhatsApp demo number now answers as this clinic.");
                setProfile(null); setName(""); setWebsite(""); setDetails(""); setDoctorName(""); setSpecialty("");
                await load();
                window.dispatchEvent(new Event("clinicq:clinic-changed"));
              } catch { setErr("Couldn't create the demo. Try again."); } finally { setBusy(""); }
            }}>{busy === "create" ? "Creating…" : "Create demo"}</button>
          </div>
          {profile && <ProfileEditor p={profile} onChange={setProfile} />}
        </section>

        {kit && (
          <section className="card" id="kit">
            <div className="section-head"><h2 style={{ margin: 0 }}>Demo kit · {kit.clinicName}</h2><button className="noprint" onClick={() => window.print()}>Print kit</button></div>
            <div className="kit">
              <div>
                <h3>Book on WhatsApp</h3>
                <p className="small muted">Prospect scans and says something like “kal shaam appointment chahiye”.</p>
                <img src={kit.chatQr} alt="QR code to chat with the clinic on WhatsApp" />
                <p className="small mono">{prettyNum(kit.waNumber)}</p>
              </div>
              <div>
                <h3>Walk-in at reception</h3>
                <p className="small muted">Joins today's token queue. The code changes every midnight.</p>
                <img src={kit.walkinQr} alt="Walk-in QR code" />
                <p className="small mono">{kit.walkinText}</p>
              </div>
            </div>
            <h3 style={{ marginTop: 16 }}>Show these next</h3>
            <ol className="small" style={{ paddingLeft: 18, lineHeight: 1.8 }}>
              <li>Open the <a href={`${BASE}/`}>queue board</a> on a laptop; tap <b>Consultation completed</b> and watch the prospect's phone get “you're next”.</li>
              <li>Put the <a href={kit.displayUrl} target="_blank" rel="noreferrer">waiting-room TV</a> on a second screen.</li>
              <li>From the presenter phone send <b>LATE 15</b> — everyone waiting is told.</li>
              <li>Send a voice note in Hindi asking for a time; it's understood, and nothing about health is stored.</li>
            </ol>
          </section>
        )}
      </div>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>Clinics on the demo number</h2>
        {demos.length === 0 && <div className="empty">No demos yet. Create one above.</div>}
        <div className="table-wrap"><table>
          <thead><tr><th>Clinic</th><th>Doctor</th><th>Area</th><th>Type</th><th /></tr></thead>
          <tbody>{demos.map((d) => (
            <tr key={d.id}>
              <td><b>{d.name}</b> {d.active && <span className="pill mint">Active</span>}</td>
              <td>{d.doctor}</td><td className="muted">{d.addressShort}</td>
              <td>{d.isDemo ? <span className="pill saffron">Demo</span> : <span className="pill blue">Live</span>}</td>
              <td className="row" style={{ justifyContent: "flex-end" }}>
                {!d.active && <button className="small" onClick={async () => { await api(`/api/demo/${d.id}/activate`, { body: {} }); window.location.reload(); }}>Make active</button>}
                {d.isDemo && <button className="small" onClick={async () => { if (confirm(`Reset ${d.name}? Bookings and the queue go back to fresh sample data.`)) { await api(`/api/demo/${d.id}/reset`, { body: {} }); setNote(`${d.name} reset.`); } }}>Reset</button>}
                {d.isDemo && <button className="small warn" onClick={async () => { if (confirm(`Delete the demo ${d.name}?`)) { await api(`/api/demo/${d.id}`, { method: "DELETE" }); window.location.reload(); } }}>Delete</button>}
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      </section>
    </Shell>
  );
}

function ProfileEditor({ p, onChange }: { p: Profile; onChange: (p: Profile) => void }) {
  const set = (k: keyof Profile, v: unknown) => onChange({ ...p, [k]: v } as Profile);
  const field = (k: keyof Profile, label: string) => (
    <div style={{ flex: 1, minWidth: 180 }}><label>{label}</label><input value={(p[k] as string | null) ?? ""} onChange={(e) => set(k, e.target.value)} /></div>
  );
  return (
    <div style={{ marginTop: 18, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
      <h3>Clinic profile</h3>
      <div className="row">{field("clinicName", "Clinic name")}{field("doctorName", "Doctor")}</div>
      <div className="row">{field("qualification", "Qualification")}{field("specialty", "Specialty")}</div>
      <div className="row">{field("addressShort", "Area / city")}{field("phone", "Clinic phone")}</div>
      {field("addressFull", "Full address")}
      {field("fees", "Fees")}
      <label>Timings</label>
      {p.sessions.map((s, i) => (
        <div key={i} className="row small" style={{ margin: "4px 0" }}>
          <span className="pill blue">{s.label}</span><span>{daysText(s.days)}</span>
          <input type="time" value={s.start} style={{ width: 120 }} onChange={(e) => onChange({ ...p, sessions: p.sessions.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)) })} />
          <span>to</span>
          <input type="time" value={s.end} style={{ width: 120 }} onChange={(e) => onChange({ ...p, sessions: p.sessions.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)) })} />
          <button className="ghost small" onClick={() => onChange({ ...p, sessions: p.sessions.filter((_, j) => j !== i) })}>Remove</button>
        </div>
      ))}
    </div>
  );
}
