"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { CustomerClinics } from "@/lib/CustomerClinics";
import { Shell } from "@/lib/Shell";

// Incolo admins: add a customer clinic (step 1 of onboarding), then follow its WhatsApp connection.
export default function Clinics() {
  const [admin, setAdmin] = useState<boolean | null>(null);
  useEffect(() => { api<{ incoloAdmin?: boolean }>("/api/me").then((m) => setAdmin(!!m?.incoloAdmin)).catch(() => setAdmin(false)); }, []);
  return (
    <Shell active="/clinics" title="Clinics on their own WhatsApp number">
      {admin === false ? <div className="empty">Only Incolo admins can add customer clinics.</div> : admin && <CustomerClinics />}
    </Shell>
  );
}
