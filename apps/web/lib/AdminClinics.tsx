"use client";

// Shared by the admin portal's Clinics list and clinic page.

export interface ClinicRow {
  id: string; name: string; code: string; doctor: string; doctorPhone: string; createdAt: string; status: "ACTIVE" | "SUSPENDED" | "ARCHIVED"; statusChangedAt: string | null; logins: number;
  whatsapp: { status: string; displayPhone: string | null; verifiedName: string | null } | null;
}
export type ClinicFilter = "ACTIVE" | "SUSPENDED" | "ARCHIVED";
export const STATUS_LABEL: Record<ClinicFilter, string> = { ACTIVE: "Active", SUSPENDED: "Suspended", ARCHIVED: "Archived" };

export function WaPill({ w }: { w: ClinicRow["whatsapp"] }) {
  return w?.status === "CONNECTED" ? <span className="pill mint">{w.displayPhone ?? "Connected"}</span> : <span className="pill">{w ? "Number disconnected" : "Number not connected"}</span>;
}
