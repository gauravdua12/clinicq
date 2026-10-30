"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, BASE } from "./api";

const I = {
  queue: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 6h16M4 12h10M4 18h6" /></svg>,
  appts: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M8 3v4M16 3v4M3 10h18" /></svg>,
  reports: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 20V10M12 20V4M19 20v-7" /></svg>,
  settings: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>,
  clinics: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 21V8l8-5 8 5v13" /><path d="M12 9v6M9 12h6M4 21h16" /></svg>,
  model: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="5" y="5" width="14" height="14" rx="2" /><path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4" /></svg>,
  admins: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" /><path d="M9 12l2 2 4-4" /></svg>,
  demo: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 3l2.4 5 5.6.8-4 3.9.9 5.5L12 15.6 7.1 18.2 8 12.7 4 8.8 9.6 8z" /></svg>,
};

// A clinic's own portal: its doctor and clinic admins manage it; staff run the desk.
const LINKS = [
  { href: "/", label: "Queue", icon: I.queue },
  { href: "/appointments", label: "Appointments", icon: I.appts },
  { href: "/reports", label: "Reports", icon: I.reports, manage: true },
  { href: "/settings", label: "Settings", icon: I.settings, manage: true },
];
// Phone tab bar: shorter names when there are many tabs.
const SHORT: Record<string, string> = { "/appointments": "Bookings" };

// Incolo's admin portal: never a clinic's patients. "Open demo clinic" switches to the demo clinic's portal for a demo.
const ADMIN_LINKS = [
  { href: "/admin", label: "Clinics", icon: I.clinics },
  { href: "/admin/demo", label: "Demo Studio", short: "Demos", icon: I.demo },
  { href: "/admin/model", label: "Language model", short: "Model", icon: I.model },
  { href: "/admin/admins", label: "Incolo admins", short: "Admins", icon: I.admins },
  { href: "/", label: "Open demo clinic", short: "Demo clinic", icon: I.queue },
];

interface Me { name: string; role: "DOCTOR" | "CLINIC_ADMIN" | "STAFF"; incoloAdmin?: boolean }
interface ClinicLite { name: string; isDemo?: boolean }
type NavLink = { href: string; label: string; icon: React.ReactNode; short?: string };

export const ROLE_LABEL: Record<string, string> = { DOCTOR: "Doctor", CLINIC_ADMIN: "Clinic admin", STAFF: "Staff" };
const logout = async () => { await api("/api/auth/logout", { body: {} }); window.location.href = `${BASE}/login`; };

function Frame({ admin, links, active, me, heading, sub, badge, actions, children }: { admin?: boolean; links: NavLink[]; active: string; me: Me | null; heading: React.ReactNode; sub?: React.ReactNode; badge?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={`app${admin ? " admin" : ""}`}>
      <aside className="rail" aria-label="Main">
        <div className="brand"><span className="brand-mark">Q</span>Q-Incolo{admin && <span className="rail-tag">Admin</span>}</div>
        {links.map((l) => <Link key={l.href} href={l.href} className={`nav ${active === l.href ? "active" : ""}`}>{l.icon}{l.label}</Link>)}
        <div className="foot">
          {me && <div><b>{me.name}</b><div>{admin ? "Incolo admin" : ROLE_LABEL[me.role]}</div></div>}
          <button className="ghost small" style={{ paddingLeft: 0, marginTop: 6 }} onClick={logout}>Log out</button>
        </div>
      </aside>
      <div className="main">
        <header className="mainbar">
          <div style={{ minWidth: 0 }}>
            <div className="clinic">{heading}</div>
            {sub && <div className="small muted">{sub}</div>}
          </div>
          {badge}
          <span className="spacer" />
          {actions}
          <button className="ghost small mobile-only" onClick={logout}>Log out</button>
        </header>
        <main className="content">{children}</main>
      </div>
      <nav className="tabbar" aria-label="Main">
        {links.map((l) => <Link key={l.href} href={l.href} className={active === l.href ? "active" : ""}>{l.icon}{links.length > 4 ? (l.short ?? SHORT[l.href] ?? l.label) : l.label}</Link>)}
      </nav>
    </div>
  );
}

function useMe(): Me | null {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => { api<Me>("/api/me").then(setMe).catch(() => undefined); }, []);
  return me;
}

/** A clinic's portal. An Incolo admin here is in the demo clinic, with a way back to the admin portal. */
export function Shell({ active, children, title, actions }: { active: string; children: React.ReactNode; title?: React.ReactNode; actions?: React.ReactNode }) {
  const me = useMe();
  const [clinic, setClinic] = useState<ClinicLite | null>(null);
  useEffect(() => {
    const loadClinic = () => api<ClinicLite>("/api/clinic").then(setClinic).catch(() => undefined);
    void loadClinic();
    window.addEventListener("clinicq:clinic-changed", loadClinic);
    return () => window.removeEventListener("clinicq:clinic-changed", loadClinic);
  }, []);
  const manages = me?.role === "DOCTOR" || me?.role === "CLINIC_ADMIN";
  const links: NavLink[] = [...LINKS.filter((l) => !l.manage || manages), ...(me?.incoloAdmin ? [{ href: "/admin", label: "Admin portal", short: "Admin", icon: I.admins }] : [])];
  return (
    <Frame links={links} active={active} me={me} heading={clinic?.name ?? "Q-Incolo"} sub={title} badge={clinic?.isDemo ? <span className="demopill">Demo</span> : undefined} actions={actions}>
      {children}
    </Frame>
  );
}

/** Incolo's admin portal. Anyone else sees a pointer back to their clinic. */
export function AdminShell({ active, children, title, actions }: { active: string; children: React.ReactNode; title?: React.ReactNode; actions?: React.ReactNode }) {
  const me = useMe();
  return (
    <Frame admin links={ADMIN_LINKS} active={active} me={me} heading="Incolo admin portal" sub={title} badge={<span className="pill blue">Incolo only</span>} actions={actions}>
      {me && !me.incoloAdmin ? <div className="empty">This part of Q-Incolo is for Incolo&apos;s team. <Link href="/">Go to your clinic</Link></div> : me ? children : <p className="muted">Loading…</p>}
    </Frame>
  );
}
