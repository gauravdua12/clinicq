"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, BASE } from "./api";

const I = {
  queue: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 6h16M4 12h10M4 18h6" /></svg>,
  appts: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M8 3v4M16 3v4M3 10h18" /></svg>,
  reports: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 20V10M12 20V4M19 20v-7" /></svg>,
  settings: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>,
  demo: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 3l2.4 5 5.6.8-4 3.9.9 5.5L12 15.6 7.1 18.2 8 12.7 4 8.8 9.6 8z" /></svg>,
};

const LINKS = [
  { href: "/", label: "Queue", icon: I.queue },
  { href: "/appointments", label: "Appointments", icon: I.appts },
  { href: "/reports", label: "Reports", icon: I.reports, doctor: true },
  { href: "/settings", label: "Settings", icon: I.settings, doctor: true },
  { href: "/demo", label: "Demo Studio", icon: I.demo, doctor: true, incolo: true },
];

interface Me { name: string; role: string; incoloAdmin?: boolean }
interface ClinicLite { name: string; isDemo?: boolean }

export function Shell({ active, children, title, actions }: { active: string; children: React.ReactNode; title?: React.ReactNode; actions?: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [clinic, setClinic] = useState<ClinicLite | null>(null);
  useEffect(() => {
    api<Me>("/api/me").then(setMe).catch(() => undefined);
    const loadClinic = () => api<ClinicLite>("/api/clinic").then(setClinic).catch(() => undefined);
    void loadClinic();
    window.addEventListener("clinicq:clinic-changed", loadClinic);
    return () => window.removeEventListener("clinicq:clinic-changed", loadClinic);
  }, []);
  const links = LINKS.filter((l) => (!l.doctor || me?.role === "DOCTOR") && (!("incolo" in l) || me?.incoloAdmin));
  return (
    <div className="app">
      <aside className="rail" aria-label="Main">
        <div className="brand"><span className="brand-mark">Q</span>Q-Incolo</div>
        {links.map((l) => <Link key={l.href} href={l.href} className={`nav ${active === l.href ? "active" : ""}`}>{l.icon}{l.label}</Link>)}
        <div className="foot">
          {me && <div><b style={{ color: "var(--ink)" }}>{me.name}</b><div>{me.role === "DOCTOR" ? "Doctor · admin" : "Staff"}</div></div>}
          <button className="ghost small" style={{ paddingLeft: 0, marginTop: 6 }} onClick={async () => { await api("/api/auth/logout", { body: {} }); window.location.href = `${BASE}/login`; }}>Log out</button>
        </div>
      </aside>
      <div className="main">
        <header className="mainbar">
          <div style={{ minWidth: 0 }}>
            <div className="clinic">{clinic?.name ?? "Q-Incolo"}</div>
            {title && <div className="small muted">{title}</div>}
          </div>
          {clinic?.isDemo && <span className="demopill">Demo</span>}
          <span className="spacer" />
          {actions}
        </header>
        <main className="content">{children}</main>
      </div>
      <nav className="tabbar" aria-label="Main">
        {links.slice(0, 4).map((l) => <Link key={l.href} href={l.href} className={active === l.href ? "active" : ""}>{l.icon}{l.label}</Link>)}
      </nav>
    </div>
  );
}
