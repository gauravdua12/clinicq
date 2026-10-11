"use client";

import { useEffect, useRef, useState } from "react";
import { api, splitToken, subscribe } from "@/lib/api";

interface E { token: string; firstName: string | null }
interface State { clinicName: string; session: string | null; inConsult: E | null; next: E | null; waiting: E[]; delayMin: number; pauseUntil: string | null; voiceCallout: boolean }

function BigStub({ e, label, kind }: { e: E | null; label: string; kind: "consult" | "next" }) {
  const t = e ? splitToken(e.token) : null;
  return (
    <div className={`stub big ${kind}`} style={{ minHeight: "28vh", ["--notch" as string]: "22px", gridTemplateColumns: "1fr" }}>
      <div style={{ padding: "3vh 4vw" }}>
        <div style={{ fontSize: "clamp(18px, 2.2vw, 30px)", fontWeight: 700, opacity: 0.85 }}>{label}</div>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "clamp(72px, 13vw, 200px)", lineHeight: 1, letterSpacing: "-0.03em", fontVariantNumeric: "tabular-nums" }}>
          {t ? <><span style={{ fontSize: "0.4em", opacity: 0.7, marginRight: "0.08em" }}>{t.s}</span>{t.n}</> : "—"}
        </div>
        {e?.firstName && <div style={{ fontSize: "clamp(22px, 2.8vw, 40px)", fontWeight: 600 }}>{e.firstName}</div>}
      </div>
    </div>
  );
}

export default function Display() {
  const [s, setS] = useState<State | null>(null);
  const [err, setErr] = useState(false);
  const [clock, setClock] = useState("");
  const lastNext = useRef<string | null>(null);
  const key = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("key") ?? "" : "";

  useEffect(() => {
    const load = () => api<State>(`/api/display/state?key=${encodeURIComponent(key)}`).then((x) => { setS(x); setErr(false); }).catch(() => setErr(true));
    void load();
    const off = subscribe(`/api/display/events?key=${encodeURIComponent(key)}`, () => void load());
    const t = setInterval(load, 20_000);
    const c = setInterval(() => setClock(new Date().toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })), 1000);
    return () => { off(); clearInterval(t); clearInterval(c); };
  }, [key]);

  useEffect(() => {
    if (!s?.voiceCallout || !s.next || s.next.token === lastNext.current) return;
    const first = lastNext.current === null;
    lastNext.current = s.next.token;
    if (first || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(`Token ${s.next.token.replace("-", " ")}, please be ready.`);
    u.lang = "en-IN";
    window.speechSynthesis.speak(u);
  }, [s]);

  if (err) return <div style={{ padding: 40, fontSize: 24 }}>This display link isn't valid. Open it again from Settings → Walk-in QR & TV.</div>;
  if (!s) return <div style={{ padding: 40, fontSize: 24 }}>Loading…</div>;
  return (
    <div style={{ minHeight: "100vh", padding: "3vh 3vw", display: "flex", flexDirection: "column", gap: "2.5vh" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 16, fontSize: "clamp(20px, 2.2vw, 32px)", fontWeight: 700, fontFamily: "var(--font-display)" }}>
        <span className="brand-mark" style={{ width: "1.6em", height: "1.6em", fontSize: "0.7em" }}>Q</span>
        <span>{s.clinicName}</span>
        <span className="spacer" style={{ flex: 1 }} />
        {s.session && <span className="muted" style={{ fontWeight: 600 }}>{s.session} session</span>}
        <span className="mono" style={{ color: "var(--blue)" }}>{clock}</span>
      </header>
      {(s.delayMin > 0 || s.pauseUntil) && <div className="banner" style={{ fontSize: "clamp(20px, 2vw, 30px)", margin: 0 }}>{s.pauseUntil ? "Doctor is on a short break and will be back soon." : `Doctor is running about ${s.delayMin} minutes late. Thank you for waiting.`}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: "2.5vw" }}>
        <BigStub e={s.inConsult} label="Now in consultation" kind="consult" />
        <BigStub e={s.next} label="Next — please be ready" kind="next" />
      </div>
      <section className="card" style={{ padding: "2.5vh 2.5vw" }}>
        <div className="eyebrow" style={{ fontSize: "clamp(14px, 1.4vw, 20px)" }}>Waiting</div>
        <div style={{ display: "flex", gap: "1.5vw", flexWrap: "wrap", marginTop: 10 }}>
          {s.waiting.length ? s.waiting.map((w) => {
            const t = splitToken(w.token);
            return (
              <div key={w.token} className="stub" style={{ gridTemplateColumns: "auto auto", minHeight: 0 }}>
                <div className="tk" style={{ borderRight: w.firstName ? undefined : "none" }}><span className="s" style={{ fontSize: 18 }}>{t.s}</span><span className="n" style={{ fontSize: "clamp(32px, 3.6vw, 56px)" }}>{t.n}</span></div>
                {w.firstName && <div className="who" style={{ fontSize: "clamp(16px, 1.6vw, 24px)", fontWeight: 600 }}>{w.firstName}</div>}
              </div>
            );
          }) : <span className="muted" style={{ fontSize: 24 }}>No one waiting</span>}
        </div>
      </section>
      <footer className="muted" style={{ fontSize: "clamp(14px, 1.3vw, 20px)" }}>Check your turn on WhatsApp anytime. Just send "status".</footer>
    </div>
  );
}
