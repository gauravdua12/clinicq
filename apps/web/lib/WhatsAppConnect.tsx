"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";

// Settings → WhatsApp (customer clinics): connect the clinic's own WhatsApp Business number with Meta's Embedded Signup
// pop-up, then see its status. The pop-up returns a one-time code; the server turns it into the clinic's token.

interface Health {
  phone: { displayPhone: string | null; verifiedName: string | null; nameStatus: string | null; quality: string | null; limit: string | null; coexistence: boolean } | null;
  templates: { approved: number; pending: number; rejected: number; missing: number };
  problems: string[];
}
interface WaView {
  ownNumber: boolean;
  signup: { appId: string; configId: string; graphVersion: string } | null;
  connection: { displayPhone: string | null; verifiedName: string | null; connectedBy: string | null; connectedAt: string; checkedAt: string | null; health: Health | null } | null;
}

type FBLogin = (cb: (r: { authResponse?: { code?: string } | null; status?: string }) => void, opts: Record<string, unknown>) => void;
declare global { interface Window { FB?: { init(o: Record<string, unknown>): void; login: FBLogin }; fbAsyncInit?: () => void } }

let sdk: Promise<void> | null = null;
function loadSdk(appId: string, version: string): Promise<void> {
  sdk ??= new Promise<void>((resolve, reject) => {
    window.fbAsyncInit = () => { window.FB!.init({ appId, autoLogAppEvents: true, xfbml: false, version }); resolve(); };
    const s = document.createElement("script");
    s.src = "https://connect.facebook.net/en_US/sdk.js";
    s.async = true; s.defer = true; s.crossOrigin = "anonymous";
    s.onerror = () => { sdk = null; reject(new Error("sdk")); };
    document.body.appendChild(s);
  });
  return sdk;
}

const ERR: Record<string, string> = {
  code_exchange_failed: "Meta didn't accept the sign-up (it may have expired). Please try Connect again.",
  number_not_found: "That number isn't in the WhatsApp account you picked. Try again and choose the clinic's number.",
  number_in_use: "That number is already connected to another clinic on Q-Incolo.",
  not_configured: "WhatsApp sign-up isn't set up on this server yet. Please contact Incolo.",
  not_customer_clinic: "This clinic runs on the Q-Incolo demo number, so there is nothing to connect.",
};
const QUALITY: Record<string, string> = { GREEN: "High", YELLOW: "Medium", RED: "Low" };
const LIMIT: Record<string, string> = { TIER_250: "250 a day", TIER_1K: "1,000 a day", TIER_10K: "10,000 a day", TIER_100K: "100,000 a day", TIER_UNLIMITED: "Unlimited" };

export function WhatsAppTab() {
  const [d, setD] = useState<WaView | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(async () => setD(await api<WaView>("/api/whatsapp")), []);
  useEffect(() => { void load(); }, [load]);
  if (!d) return <p className="muted">Loading…</p>;

  const connect = async (coexistence: boolean) => {
    if (!d.signup) return setMsg({ ok: false, text: ERR.not_configured! });
    setMsg(null); setBusy(true);
    try { await loadSdk(d.signup.appId, d.signup.graphVersion); }
    catch { setBusy(false); return setMsg({ ok: false, text: "Couldn't load Facebook's sign-in. Check the internet connection or any ad blocker, then try again." }); }
    let session: { wabaId?: string; phoneNumberId?: string; cancelledAt?: string } = {};
    const onMessage = (ev: MessageEvent) => {
      let host = "";
      try { host = new URL(ev.origin).hostname; } catch { return; }
      if (!/(^|\.)facebook\.com$/.test(host)) return;
      try {
        const m = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
        if (m?.type !== "WA_EMBEDDED_SIGNUP") return;
        if (String(m.event).startsWith("FINISH")) session = { wabaId: m.data?.waba_id, phoneNumberId: m.data?.phone_number_id };
        else if (m.event === "CANCEL") session = { cancelledAt: m.data?.current_step ?? "" };
      } catch { /* other Facebook messages */ }
    };
    window.addEventListener("message", onMessage);
    window.FB!.login((resp) => {
      const code = resp.authResponse?.code;
      // The pop-up's last message can arrive just after this callback.
      setTimeout(() => {
        window.removeEventListener("message", onMessage);
        if (!code || !session.wabaId || !session.phoneNumberId) {
          setBusy(false);
          return setMsg({ ok: false, text: session.cancelledAt !== undefined || !code ? "Sign-up was closed before it finished. Nothing was connected." : "Meta didn't say which number was chosen. Please try again." });
        }
        api<WaView & { problems: string[] }>("/api/whatsapp/connect", { body: { code, wabaId: session.wabaId, phoneNumberId: session.phoneNumberId, coexistence } })
          .then((r) => { setD(r); setMsg({ ok: !r.problems.length, text: r.problems.length ? `Connected, with something to finish: ${r.problems.join("; ")}` : "Connected. Q-Incolo now answers patients on this number. Message templates were sent to Meta for approval (usually minutes)." }); })
          .catch((e) => setMsg({ ok: false, text: (e instanceof ApiError && ERR[e.code]) || "Couldn't finish connecting. Please try again." }))
          .finally(() => setBusy(false));
      }, 800);
    }, {
      config_id: d.signup.configId, response_type: "code", override_default_response_type: true,
      extras: { setup: {}, sessionInfoVersion: "3", ...(coexistence ? { featureType: "whatsapp_business_app_onboarding" } : {}) },
    });
  };

  if (!d.ownNumber) return <div className="card"><p className="muted" style={{ margin: 0 }}>This clinic runs on the Q-Incolo demo number. Customer clinics connect their own WhatsApp number here.</p></div>;

  const c = d.connection;
  const h = c?.health;
  return (
    <div className="card" style={{ maxWidth: 680 }}>
      {msg && <div className={msg.ok ? "ok" : "err"} role="status" style={{ marginBottom: 12 }}>{msg.text}</div>}
      {!c ? (
        <>
          <h2 style={{ marginTop: 0 }}>Connect your clinic&apos;s WhatsApp number</h2>
          <p>Patients will message your clinic&apos;s own number, see your clinic&apos;s name, and get confirmations and reminders from it. It takes about 10 minutes.</p>
          <ol className="small" style={{ paddingLeft: 18, lineHeight: 1.6 }}>
            <li>Log in with Facebook (the person who manages the clinic&apos;s business).</li>
            <li>Pick or create your business portfolio, with the clinic&apos;s legal name and address.</li>
            <li>Add the clinic&apos;s number and verify it with the code Meta sends by SMS or call. The display name should be your clinic&apos;s name.</li>
          </ol>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" disabled={busy} onClick={() => void connect(false)}>{busy ? "Connecting…" : "Connect WhatsApp"}</button>
            <button disabled={busy} onClick={() => void connect(true)}>I use the WhatsApp Business app on this number</button>
          </div>
          <p className="small muted" style={{ marginBottom: 0 }}>Already on the WhatsApp Business app? Use the second button: you keep the app and your chats, and Q-Incolo answers on the same number. A number on the regular WhatsApp app can&apos;t be used; move it to WhatsApp Business first.</p>
        </>
      ) : (
        <>
          <h2 style={{ marginTop: 0 }}>{c.verifiedName ?? "Your WhatsApp number"} <span className="pill mint">Connected</span></h2>
          <p style={{ marginTop: 0 }}><b>{c.displayPhone}</b> · connected {new Date(c.connectedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}{c.connectedBy ? ` by ${c.connectedBy}` : ""}</p>
          {h ? (
            <dl className="wa-health">
              <dt>Display name</dt><dd>{h.phone?.nameStatus === "APPROVED" ? "Approved" : h.phone?.nameStatus ? `${h.phone.nameStatus.replace(/_/g, " ").toLowerCase()}` : "—"}</dd>
              <dt>Quality</dt><dd>{(h.phone?.quality && QUALITY[h.phone.quality]) ?? "—"}</dd>
              <dt>Messages you can start</dt><dd>{(h.phone?.limit && LIMIT[h.phone.limit]) ?? "—"}</dd>
              <dt>Message templates</dt><dd>{h.templates.approved} approved{h.templates.pending ? ` · ${h.templates.pending} waiting` : ""}{h.templates.rejected ? ` · ${h.templates.rejected} rejected` : ""}{h.templates.missing ? ` · ${h.templates.missing} not sent yet` : ""}</dd>
            </dl>
          ) : <p className="small muted">Checking the number and templates with Meta…</p>}
          {!!h?.problems?.length && <div className="err small">{h.problems.join("; ")}</div>}
          <p className="small muted">To send reminders and confirmations, add a payment method for your WhatsApp account in <a href="https://business.facebook.com/wa/manage/home/" target="_blank" rel="noreferrer">WhatsApp Manager</a>. Meta bills your business directly; replies to patients within 24 hours are free.</p>
          <div className="row">
            <button disabled={busy} onClick={async () => { setBusy(true); try { setD(await api<WaView>("/api/whatsapp/check", { body: {} })); setMsg(null); } catch { setMsg({ ok: false, text: "Couldn't reach Meta. Try again in a minute." }); } finally { setBusy(false); } }}>Check status</button>
            {!!h && (h.templates.missing > 0 || h.templates.rejected > 0) && <button disabled={busy} onClick={async () => { setBusy(true); try { const r = await api<{ created: number }>("/api/whatsapp/templates", { body: {} }); setMsg({ ok: true, text: `${r.created} template(s) sent to Meta.` }); } catch { setMsg({ ok: false, text: "Couldn't send the templates. Try again." }); } finally { setBusy(false); } }}>Send missing templates</button>}
            <span className="spacer" />
            <button className="ghost warn" disabled={busy} onClick={async () => {
              if (!confirm("Disconnect this WhatsApp number? Q-Incolo will stop answering patients on it straight away.")) return;
              setBusy(true); try { setD(await api<WaView>("/api/whatsapp/disconnect", { body: {} })); setMsg({ ok: true, text: "Disconnected. Q-Incolo no longer answers on this number." }); } finally { setBusy(false); }
            }}>Disconnect</button>
          </div>
        </>
      )}
    </div>
  );
}
