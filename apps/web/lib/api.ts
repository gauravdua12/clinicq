"use client";

export const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
export const API = process.env.NEXT_PUBLIC_API_BASE ?? BASE;

export class ApiError extends Error {
  constructor(public status: number, public code: string, public body?: unknown) { super(code); }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    credentials: "include",
    headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/api/auth") && !path.startsWith("/api/display")) {
    window.location.href = `${BASE}/login`;
  }
  if (res.status === 403 && json?.error?.code === "clinic_paused" && typeof window !== "undefined") window.location.href = `${BASE}/login?paused=1`;
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? json?.reason ?? "error", json);
  return json as T;
}

export function subscribe(path: string, onEvent: (type: string, data: unknown) => void): () => void {
  const es = new EventSource(`${API}${path}`, { withCredentials: true });
  const types = ["queue.updated", "appointment.changed", "overflow.requested", "overflow.resolved", "doctor.status", "callback.requested", "system.alert", "payment.claimed"];
  for (const t of types) es.addEventListener(t, (e) => onEvent(t, JSON.parse((e as MessageEvent).data)));
  return () => es.close();
}

export interface EntryView {
  id: string; token: string; source: "A" | "W"; state: string; name: string; firstName: string;
  arrivedAt: string; slotStart: string | null; expectedAt: string | null; lateArrival: boolean; etaMin: number | null; ahead: number | null; version: number; hasWhatsApp: boolean;
}
export interface QueueSnapshot {
  date: string; session: { id: string; label: string; startTime: string; endTime: string } | null;
  inConsult: EntryView | null; next: EntryView | null; waiting: EntryView[];
  counts: { booked: number; walkins: number; completed: number; noShow: number; waiting: number };
  avgConsultMin: number; delayMin: number; pauseUntil: string | null; demo?: boolean;
}

export const fmtClock = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "");

/** "W-12" → { s: "W", n: "12" } for the token stub. */
export function splitToken(t: string): { s: string; n: string } {
  const m = t.match(/^([A-Z]+)-?(\d+)$/);
  return m ? { s: m[1]!, n: m[2]! } : { s: "", n: t };
}
