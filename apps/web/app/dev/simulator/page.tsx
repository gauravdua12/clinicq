"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, BASE } from "@/lib/api";

// Dev-only WhatsApp simulator: posts signed Meta-format webhooks to the real /webhook route.

type Msg =
  | { kind: "text"; body: string }
  | { kind: "buttons"; body: string; buttons: { id: string; title: string }[] }
  | { kind: "list"; body: string; button: string; sections: { title: string; rows: { id: string; title: string }[] }[] }
  | { kind: "flow"; body: string; cta: string }
  | { kind: "cta_url"; body: string; displayText: string; url: string }
  | { kind: "contact"; name: string; phone: string }
  | { kind: "template"; name: string; bodyParams: string[]; quickReplyPayloads?: string[] };
interface Out { id: string; to: string; at: number; msg: Msg }
interface Bubble { from: "me" | "bot"; at: number; msg?: Msg; text?: string }

function Phone({ number, name, title }: { number: string; name: string; title: string }) {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"text" | "voice">("text");
  const since = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const poll = useCallback(async () => {
    const out = await api<Out[]>(`/dev/outbox?to=${number}&since=${since.current}`);
    if (out.length) {
      since.current = out.at(-1)!.at;
      setBubbles((b) => [...b, ...out.map((o) => ({ from: "bot" as const, at: o.at, msg: o.msg }))]);
    }
  }, [number]);
  useEffect(() => { const t = setInterval(poll, 800); return () => clearInterval(t); }, [poll]);
  useEffect(() => { box.current?.scrollTo({ top: 1e9 }); }, [bubbles]);
  const send = async (body: Record<string, unknown>, label: string) => {
    setBubbles((b) => [...b, { from: "me", at: Date.now(), text: label }]);
    await api("/dev/simulate", { body: { from: number, name, ...body } });
    await poll();
  };
  return (
    <div className="card" style={{ width: 380, display: "flex", flexDirection: "column", height: "80vh" }}>
      <div className="row" style={{ justifyContent: "space-between" }}><b>{title}</b><span className="small muted">+{number}</span></div>
      <div ref={box} style={{ flex: 1, overflowY: "auto", background: "var(--surface-2)", borderRadius: 10, padding: 8, margin: "8px 0" }}>
        {bubbles.map((b, i) => (
          <div key={i} style={{ display: "flex", justifyContent: b.from === "me" ? "flex-end" : "flex-start", margin: "6px 0" }}>
            <div style={{ maxWidth: "85%", background: b.from === "me" ? "var(--accent-bg)" : "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "6px 10px", whiteSpace: "pre-wrap", fontSize: 14 }}>
              {b.text}
              {b.msg && <Render msg={b.msg} onTap={(id, title) => send({ type: "button", buttonId: id, buttonTitle: title }, `[${title}]`)} />}
            </div>
          </div>
        ))}
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (!text.trim()) return; void send(mode === "voice" ? { type: "voice", voiceText: text } : { type: "text", text }, mode === "voice" ? `🎤 ${text}` : text); setText(""); }}>
        <select value={mode} onChange={(e) => setMode(e.target.value as "text" | "voice")} style={{ width: 90 }}><option value="text">Text</option><option value="voice">Voice</option></select>
        <input style={{ flex: 1 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={mode === "voice" ? "What the patient says…" : "Type a message"} />
        <button className="primary">Send</button>
      </form>
      <div className="row small" style={{ marginTop: 6 }}><button className="small" onClick={() => send({ type: "image" }, "📷 [photo]")}>Send photo</button></div>
    </div>
  );
}

function Render({ msg, onTap }: { msg: Msg; onTap: (id: string, title: string) => void }) {
  if (msg.kind === "text") return <>{msg.body}</>;
  if (msg.kind === "contact") return <>📇 {msg.name} · {msg.phone}</>;
  if (msg.kind === "template") return <><span className="pill">template</span> {msg.name}<br />{msg.bodyParams.join(" · ")}{msg.quickReplyPayloads?.map((p) => <button key={p} className="small" style={{ display: "block", width: "100%", marginTop: 4 }} onClick={() => onTap(p, p.split(":")[1] ?? p)}>{p.split(":")[1]}</button>)}</>;
  if (msg.kind === "cta_url") return <>{msg.body}<a className="btn small" style={{ display: "block", textAlign: "center", marginTop: 6 }} href={msg.url} target="_blank" rel="noopener">↗ {msg.displayText}</a></>;
  if (msg.kind === "flow") return <>{msg.body}<button className="small" style={{ display: "block", width: "100%", marginTop: 6 }} disabled>{msg.cta} (Flow)</button></>;
  const btns = msg.kind === "buttons" ? msg.buttons : msg.sections.flatMap((s) => s.rows.map((r) => ({ id: r.id, title: `${s.title}: ${r.title}` })));
  return <>{msg.body}{btns.map((b) => <button key={b.id} className="small" style={{ display: "block", width: "100%", marginTop: 4 }} onClick={() => onTap(b.id, b.title)}>{b.title}</button>)}</>;
}

export default function Simulator() {
  const [patient, setPatient] = useState("919876543210");
  const [name, setName] = useState("Ramesh Kumar");
  const [clock, setClock] = useState("");
  return (
    <div className="shell">
      <h1>WhatsApp simulator</h1>
      <p className="small muted">Dev only. Messages go through the real webhook, conversation engine and database. Staff numbers in the demo seed: doctor 99999 00001, Priya 99999 00002.</p>
      <div className="row" style={{ marginBottom: 12 }}>
        <input style={{ width: 180 }} value={patient} onChange={(e) => setPatient(e.target.value)} aria-label="Patient number" />
        <input style={{ width: 180 }} value={name} onChange={(e) => setName(e.target.value)} aria-label="WhatsApp profile name" />
        <input style={{ width: 220 }} type="datetime-local" value={clock} onChange={(e) => setClock(e.target.value)} aria-label="Clock" />
        <button onClick={async () => { if (clock) await api("/dev/clock", { body: { now: new Date(clock).toISOString() } }); }}>Set clock + run jobs</button>
        <a href={`${BASE}/`}>Dashboard</a>
      </div>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <Phone key={patient} number={patient} name={name} title="Patient" />
        <Phone number="919999900002" name="Priya" title="Staff: Priya" />
        <Phone number="919999900001" name="Dr. Sharma" title="Doctor" />
      </div>
    </div>
  );
}
