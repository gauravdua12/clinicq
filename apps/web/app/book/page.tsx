"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { API } from "@/lib/api";

// Booking page (form D), opened from the "Choose date & time" button in WhatsApp: /book?t=<one-time token>.
// Swipe through dates, then pick a slot from the Morning / Evening rows; nothing is booked until "Confirm booking".

type Lang = "en" | "hi" | "hinglish";
type Visit = "NEW" | "FOLLOW_UP" | "REPORT_SHOW";
interface DateChip { date: string; dow: string; day: string; mon: string; open: boolean; enabled: boolean; free: number }
interface Info { clinic: { name: string; address: string }; name: string; lang: Lang; waNumber: string; dates: DateChip[]; selected: string | null; suggestedVisit: Visit }
interface Slot { min: number; time: string; free: boolean }
interface Session { label: string; hours: string; free: number; slots: Slot[] }

const L = {
  en: { title: "Book an appointment", for: "For", date: "Date", closed: "Closed", free: "free", noSlots: "No times left on this day. Please pick another date.", visit: "Visit", visits: { NEW: "New consultation", FOLLOW_UP: "Follow-up", REPORT_SHOW: "Report review" }, pick: "Pick a time", cont: "Continue", confirmTitle: "Confirm booking", patient: "Patient", time: "Time", clinic: "Clinic", confirm: "Confirm booking", change: "Change", booking: "Booking…", done: "Booked", token: "Token", sent: "The details are on WhatsApp too.", back: "Back to WhatsApp", expired: "This link has expired.", expiredHint: "Go back to WhatsApp and ask for the booking link again.", taken: "That time was just taken. Please pick another.", error: "Something went wrong. Please try again.", loading: "Loading free times…" },
  hi: { title: "अपॉइंटमेंट बुक करें", for: "", date: "दिन", closed: "बंद", free: "ख़ाली", noSlots: "इस दिन कोई समय नहीं बचा। कृपया दूसरा दिन चुनें।", visit: "विज़िट", visits: { NEW: "नई कंसल्टेशन", FOLLOW_UP: "फ़ॉलो-अप", REPORT_SHOW: "रिपोर्ट दिखाने" }, pick: "समय चुनें", cont: "आगे बढ़ें", confirmTitle: "बुकिंग कन्फ़र्म करें", patient: "मरीज़", time: "समय", clinic: "क्लिनिक", confirm: "बुकिंग कन्फ़र्म करें", change: "बदलें", booking: "बुक हो रहा है…", done: "बुक हो गया", token: "टोकन", sent: "पूरी जानकारी WhatsApp पर भी भेज दी है।", back: "WhatsApp पर वापस जाएँ", expired: "यह लिंक पुराना हो गया है।", expiredHint: "WhatsApp पर वापस जाकर बुकिंग लिंक दोबारा माँगें।", taken: "यह समय अभी-अभी बुक हो गया। कृपया दूसरा चुनें।", error: "कुछ गड़बड़ हुई। कृपया फिर से कोशिश करें।", loading: "ख़ाली समय लोड हो रहे हैं…" },
  hinglish: { title: "Appointment book karein", for: "", date: "Din", closed: "Band", free: "khaali", noSlots: "Is din koi time nahi bacha. Doosra din chuniye.", visit: "Visit", visits: { NEW: "Nayi consultation", FOLLOW_UP: "Follow-up", REPORT_SHOW: "Report dikhane" }, pick: "Time chuniye", cont: "Aage badhein", confirmTitle: "Booking confirm karein", patient: "Patient", time: "Time", clinic: "Clinic", confirm: "Booking confirm karein", change: "Badlein", booking: "Book ho raha hai…", done: "Book ho gaya", token: "Token", sent: "Poori details WhatsApp par bhi bhej di hain.", back: "WhatsApp par wapas jaayein", expired: "Yeh link purana ho gaya hai.", expiredHint: "WhatsApp par wapas jaakar booking link dobara maangiye.", taken: "Yeh time abhi-abhi book ho gaya. Doosra chuniye.", error: "Kuch gadbad hui. Phir se koshish karein.", loading: "Khaali time load ho rahe hain…" },
} as const;

/**
 * Slots in columns of 1–3 (by how many there are), read top to bottom, then scroll right for later times.
 * A column that contains the start of an hour gets an hour marker above it ("10 AM").
 */
function columns(slots: Slot[]): { hour: string | null; slots: Slot[] }[] {
  const rows = slots.length > 24 ? 3 : slots.length > 8 ? 2 : 1;
  const out: { hour: string | null; slots: Slot[] }[] = [];
  let lastHour = -1;
  for (let i = 0; i < slots.length; i += rows) {
    const col = slots.slice(i, i + rows);
    const h = Math.floor(col[col.length - 1]!.min / 60);
    const starts = i === 0 || h !== lastHour;
    if (starts) lastHour = h;
    out.push({ hour: starts ? `${((h + 11) % 12) + 1} ${h < 12 ? "AM" : "PM"}` : null, slots: col });
  }
  return out;
}

const prettyDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });

export default function Book() {
  const [token, setToken] = useState("");
  const [info, setInfo] = useState<Info | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "expired" | "done" | "error">("loading");
  const [date, setDate] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [visit, setVisit] = useState<Visit>("NEW");
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [booked, setBooked] = useState<{ token: string; date: string; time: string } | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  const t = L[info?.lang ?? "en"];

  const call = useCallback(async (path: string, body?: unknown) => {
    const r = await fetch(`${API}/api/book/${token}${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
    const j = await r.json().catch(() => ({}));
    return { status: r.status, j };
  }, [token]);

  useEffect(() => { setToken(new URLSearchParams(window.location.search).get("t") ?? ""); }, []);
  useEffect(() => {
    if (!token) return;
    void (async () => {
      const { status, j } = await call("");
      if (status === 410) return setState("expired");
      if (status !== 200) return setState("error");
      setInfo(j as Info); setVisit((j as Info).suggestedVisit); setDate((j as Info).selected); setState("ready");
    })();
  }, [token, call]);
  useEffect(() => {
    if (!date || !token) return;
    setSessions(null); setSlot(null);
    void (async () => {
      const { status, j } = await call(`/day/${date}`);
      if (status === 410) return setState("expired");
      setSessions((j as { sessions: Session[] }).sessions ?? []);
    })();
    strip.current?.querySelector<HTMLElement>(`[data-date="${date}"]`)?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }, [date, token, call]);

  const confirm = async () => {
    if (!slot || !date) return;
    setBusy(true); setNotice("");
    const { status, j } = await call("/confirm", { date, min: slot.min, visitType: visit });
    setBusy(false);
    if (status === 200) { setBooked({ token: j.token, date, time: j.time }); setSheet(false); setState("done"); return; }
    if (status === 410) { setSheet(false); return setState("expired"); }
    setSheet(false); setSlot(null);
    if (j?.sessions) setSessions(j.sessions);
    setNotice(status === 409 ? t.taken : t.error);
  };

  if (state === "loading") return <main className="bk"><p className="bk-muted">{L.en.loading}</p></main>;
  if (state === "expired" || state === "error") return (
    <main className="bk bk-center">
      <div className="bk-mark warn" aria-hidden>!</div>
      <h1>{state === "expired" ? t.expired : t.error}</h1>
      <p className="bk-muted">{t.expiredHint}</p>
      {info?.waNumber && <a className="bk-cta" href={`https://wa.me/${info.waNumber}`}>{t.back}</a>}
    </main>
  );
  if (state === "done" && booked && info) return (
    <main className="bk bk-center">
      <div className="bk-mark ok" aria-hidden>✓</div>
      <h1>{t.done}</h1>
      <div className="bk-ticket">
        <div><span className="bk-muted">{t.token}</span><b>{booked.token}</b></div>
        <div>{info.name && <>{info.name} ji · </>}{prettyDate(booked.date)}, {booked.time}</div>
        <div className="bk-muted">{t.visits[visit]} · {info.clinic.name}</div>
      </div>
      <p className="bk-muted">{t.sent}</p>
      {info.waNumber && <a className="bk-cta" href={`https://wa.me/${info.waNumber}`}>{t.back}</a>}
    </main>
  );
  if (!info) return null;

  return (
    <main className="bk">
      <header className="bk-head">
        <div className="bk-clinic">{info.clinic.name}</div>
        <h1>{t.title}</h1>
        {info.name && <div className="bk-for">{t.for} <b>{info.name} ji</b></div>}
      </header>

      <section aria-label={t.date}>
        <div className="bk-label">{t.date}</div>
        <div className="bk-strip" ref={strip} role="listbox" aria-label={t.date}>
          {info.dates.map((d) => (
            <button key={d.date} data-date={d.date} role="option" aria-selected={d.date === date} disabled={!d.enabled} aria-label={`${d.dow} ${d.day} ${d.mon}${d.open ? "" : `, ${t.closed}`}`}
              className={`bk-date${d.date === date ? " on" : ""}${!d.open ? " closed" : ""}`} onClick={() => setDate(d.date)}>
              <span className="dow">{d.dow}</span><span className="day">{d.day}</span><span className="mon">{d.open ? d.mon : t.closed}</span>
            </button>
          ))}
        </div>
      </section>

      {notice && <div className="bk-notice" role="alert">{notice}</div>}

      {!sessions ? <p className="bk-muted">{t.loading}</p> : sessions.length === 0 || sessions.every((s) => s.free === 0) ? <p className="bk-muted">{t.noSlots}</p> : sessions.map((s) => (
        <section key={s.label} className="bk-session" aria-label={s.label}>
          <div className="bk-label">{s.label} <span className="bk-muted">· {s.hours} · {s.free} {t.free}</span></div>
          <div className="bk-slots" role="listbox" aria-label={s.label}>
            {columns(s.slots).map((col) => (
              <div key={col.slots[0]!.min} className="bk-col">
                <div className="bk-hour" aria-hidden>{col.hour ?? ""}</div>
                {col.slots.map((x) => (
                  <button key={x.min} role="option" aria-selected={slot?.min === x.min} aria-label={x.time} disabled={!x.free}
                    className={`bk-slot${slot?.min === x.min ? " on" : ""}`} onClick={() => setSlot(x)}>
                    {x.time.replace(/ [AP]M$/, "")}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </section>
      ))}

      <section className="bk-session" aria-label={t.visit}>
        <div className="bk-label">{t.visit}</div>
        <div className="bk-visits">
          {(["NEW", "FOLLOW_UP", "REPORT_SHOW"] as Visit[]).map((v) => (
            <button key={v} className={`bk-visit${visit === v ? " on" : ""}`} aria-pressed={visit === v} onClick={() => setVisit(v)}>{t.visits[v]}</button>
          ))}
        </div>
      </section>

      <div className="bk-bar">
        <div className="bk-bar-sum">{slot && date ? <><b>{prettyDate(date)}</b>, {slot.time}</> : <span className="bk-muted">{t.pick}</span>}</div>
        <button className="bk-cta" disabled={!slot} onClick={() => setSheet(true)}>{t.cont}</button>
      </div>

      {sheet && slot && date && (
        <div className="bk-scrim" onClick={() => !busy && setSheet(false)}>
          <div className="bk-sheet" role="dialog" aria-modal="true" aria-label={t.confirmTitle} onClick={(e) => e.stopPropagation()}>
            <h2>{t.confirmTitle}</h2>
            <dl>
              {info.name && <><dt>{t.patient}</dt><dd>{info.name} ji</dd></>}
              <dt>{t.date}</dt><dd>{prettyDate(date)}</dd>
              <dt>{t.time}</dt><dd>{slot.time}</dd>
              <dt>{t.visit}</dt><dd>{t.visits[visit]}</dd>
              <dt>{t.clinic}</dt><dd>{info.clinic.name}</dd>
            </dl>
            <button className="bk-cta" disabled={busy} onClick={confirm}>{busy ? t.booking : t.confirm}</button>
            <button className="bk-ghost" disabled={busy} onClick={() => setSheet(false)}>{t.change}</button>
          </div>
        </div>
      )}
    </main>
  );
}
