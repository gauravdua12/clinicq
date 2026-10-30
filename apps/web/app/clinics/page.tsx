"use client";

import { useEffect } from "react";
import { BASE } from "@/lib/api";

// Moved to the Incolo admin portal.
export default function Moved() {
  useEffect(() => { window.location.replace(`${BASE}/admin`); }, []);
  return null;
}
