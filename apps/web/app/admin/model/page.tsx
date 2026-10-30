"use client";

import { ModelSettings } from "@/lib/ModelSettings";
import { AdminShell } from "@/lib/Shell";

export default function AdminModel() {
  return (
    <AdminShell active="/admin/model" title="Which model reads patients' messages (for every clinic)">
      <h1>Language model</h1>
      <ModelSettings />
    </AdminShell>
  );
}
