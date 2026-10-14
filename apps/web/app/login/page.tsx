"use client";

import { useState } from "react";
import { api, BASE } from "@/lib/api";
import { Stub } from "@/lib/Stub";

export default function Login() {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dev = process.env.NEXT_PUBLIC_DEV_TOOLS === "1";
  const go = () => { window.location.href = `${BASE}/`; };
  return (
    <div className="split">
      <section className="hero">
        <div className="brand" style={{ padding: 0 }}><span className="brand-mark" style={{ background: "#fff", color: "var(--blue)" }}>Q</span>ClinicQ</div>
        <div>
          <h1>Every patient knows their turn.</h1>
          <p style={{ marginTop: 14 }}>Bookings, walk-ins and the token queue run on WhatsApp. Your desk sees it all here.</p>
          <div style={{ marginTop: 28, maxWidth: 360, color: "var(--ink)" }} aria-hidden>
            <Stub kind="consult" token="A-4" name="Sunita D." meta="In consultation" />
            <Stub kind="next" token="W-7" name="Ramesh K." meta="Next · told to be ready" />
            <Stub token="A-5" name="Mohit J." meta="Booked 6:30 PM · ~15 min" />
          </div>
        </div>
        <p className="small" style={{ margin: 0 }}>Patient health details are never stored.</p>
      </section>
      <section className="form">
        <div className="card stack">
          <div>
            <h1 style={{ fontSize: 22 }}>Sign in</h1>
            <p className="muted small" style={{ margin: "4px 0 0" }}>Use the WhatsApp number registered for your clinic.</p>
          </div>
          {!sent ? (
            <form onSubmit={async (e) => {
              e.preventDefault();
              if (!/\d{10}/.test(phone.replace(/\D/g, ""))) return setErr("Enter a 10-digit mobile number.");
              setBusy(true); await api("/api/auth/otp", { body: { phone } }).finally(() => setBusy(false)); setSent(true); setErr(null);
            }}>
              <label htmlFor="ph">WhatsApp number</label>
              <input id="ph" value={phone} onChange={(e) => { setPhone(e.target.value); setErr(null); }} placeholder="98765 43210" inputMode="tel" autoComplete="tel" autoFocus />
              {err && <div className="err">{err}</div>}
              <button className="primary big" style={{ marginTop: 14 }} disabled={busy}>Send code on WhatsApp</button>
            </form>
          ) : (
            <form onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await api("/api/auth/verify", { body: { phone, code } }); go(); } catch { setErr("That code didn't match. Check the latest WhatsApp message and try again."); } finally { setBusy(false); } }}>
              <p className="small" style={{ margin: 0 }}>We sent a 6-digit code to <b>{phone}</b> on WhatsApp.</p>
              <p className="small muted" style={{ margin: "6px 0 0" }}>Not received in a minute? From this phone, send "hi" to the clinic's ClinicQ WhatsApp number, then tap <b>Use a different number</b> and send the code again.</p>
              <label htmlFor="cd">Code</label>
              <input id="cd" value={code} onChange={(e) => { setCode(e.target.value.replace(/\D/g, "")); setErr(null); }} inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus style={{ letterSpacing: "0.3em", fontSize: 20, fontFamily: "var(--font-display)" }} />
              {err && <div className="err">{err}</div>}
              <button className="primary big" style={{ marginTop: 14 }} disabled={busy || code.length !== 6}>Sign in</button>
              <button type="button" className="ghost" style={{ width: "100%", marginTop: 6 }} onClick={() => { setSent(false); setCode(""); }}>Use a different number</button>
            </form>
          )}
          {dev && (
            <div className="row small" style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>
              <span className="muted">Dev sign-in:</span>
              <button className="small" onClick={async () => { await api("/api/auth/dev-login", { body: { role: "DOCTOR" } }); go(); }}>Doctor</button>
              <button className="small" onClick={async () => { await api("/api/auth/dev-login", { body: { role: "STAFF" } }); go(); }}>Staff</button>
              <a href={`${BASE}/dev/simulator`}>Simulator</a>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
