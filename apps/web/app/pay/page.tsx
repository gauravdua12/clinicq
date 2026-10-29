"use client";

import { useEffect, useState } from "react";
import { API } from "@/lib/api";

// Pay page, opened from the "Pay now" button of a payment reminder: /pay?t=<token>. Shows the amount and the clinic's
// UPI details (app link + QR). It shows no patient details, so a forwarded link reveals nothing personal.

interface Pay { clinicName: string; clinicPhone: string; addressShort: string; amount: string; visitDate: string; status: "PENDING" | "PAID"; upiId: string | null; payeeName: string; upiLink: string | null; qr: string | null }

export default function PayPage() {
  const [p, setP] = useState<Pay | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "gone">("loading");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("t") ?? "";
    if (!t) { setState("gone"); return; }
    fetch(`${API}/api/pay/${encodeURIComponent(t)}`).then(async (r) => {
      if (!r.ok) return setState("gone");
      setP(await r.json()); setState("ready");
    }).catch(() => setState("gone"));
  }, []);

  if (state === "loading") return <main className="bk"><p className="bk-muted">Loading…</p></main>;
  if (state === "gone" || !p) return (
    <main className="bk"><div className="bk-center">
      <div className="bk-mark warn">!</div>
      <h1>This payment link isn&apos;t active</h1>
      <p className="bk-muted">The clinic may have cancelled it. If you still owe an amount, please pay at the clinic.</p>
    </div></main>
  );
  if (p.status === "PAID") return (
    <main className="bk"><div className="bk-center">
      <div className="bk-mark ok">✓</div>
      <h1>Paid. Thank you!</h1>
      <p className="bk-muted">{p.clinicName} has received ₹{p.amount} for your visit on {p.visitDate}.</p>
    </div></main>
  );
  return (
    <main className="bk">
      <div className="bk-head">
        <div className="bk-clinic">{p.clinicName}</div>
        <h1>Pay ₹{p.amount}</h1>
        <div className="bk-for">For your visit on {p.visitDate}</div>
      </div>
      {p.upiLink && <>
        <a className="bk-cta" style={{ width: "100%" }} href={p.upiLink}>Pay with a UPI app</a>
        <p className="bk-muted" style={{ fontSize: 14 }}>Opens Google Pay, PhonePe, Paytm or your bank&apos;s app with the amount filled in.</p>
        {p.qr && <div className="bk-ticket" style={{ justifyItems: "center", margin: "18px auto 0" }}>
          <div className="bk-muted" style={{ fontSize: 14 }}>Or scan from another phone</div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={p.qr} alt={`UPI QR code to pay ₹${p.amount} to ${p.payeeName}`} width={240} height={240} />
          <div style={{ fontWeight: 600 }}>{p.payeeName}</div>
          <button className="bk-ghost" style={{ marginTop: 0 }} onClick={async () => { try { await navigator.clipboard.writeText(p.upiId ?? ""); setCopied(true); } catch { /* clipboard blocked */ } }}>
            {copied ? "UPI ID copied" : `Copy UPI ID: ${p.upiId}`}
          </button>
        </div>}
      </>}
      <p className="bk-muted" style={{ marginTop: 18, fontSize: 14 }}>
        You can also pay at the clinic{p.addressShort ? ` (${p.addressShort})` : ""}. After paying, reply &quot;paid&quot; in the WhatsApp chat and the clinic will confirm.
        {p.clinicPhone ? <> Questions? Call <a href={`tel:${p.clinicPhone.replace(/\s/g, "")}`}>{p.clinicPhone}</a>.</> : null}
      </p>
    </main>
  );
}
