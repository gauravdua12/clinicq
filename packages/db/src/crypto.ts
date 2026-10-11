import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

// Field-level encryption for phone numbers and names (docs/ARCHITECTURE.md §6).
// Format: v<keyVersion>:<iv b64>:<tag b64>:<ciphertext b64>
let dataKey: Buffer | null = null;
let pepper: Buffer | null = null;

export function initCrypto(opts: { dataKeyB64: string; pepperB64: string }): void {
  const k = Buffer.from(opts.dataKeyB64, "base64");
  const p = Buffer.from(opts.pepperB64, "base64");
  if (k.length !== 32) throw new Error("DATA_KEY must be 32 bytes (base64)");
  if (p.length < 16) throw new Error("HASH_PEPPER must be at least 16 bytes (base64)");
  dataKey = k;
  pepper = p;
}

function key(): Buffer {
  if (!dataKey) throw new Error("crypto not initialised");
  return dataKey;
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}

export function decrypt(blob: string): string {
  const [v, ivB, tagB, ctB] = blob.split(":");
  if (v !== "v1" || !ivB || !tagB || ctB === undefined) throw new Error("bad ciphertext");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB, "base64"));
  d.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([d.update(Buffer.from(ctB, "base64")), d.final()]).toString("utf8");
}

/** HMAC of the normalised wa_id (digits only, with country code). */
export function phoneHash(waId: string): string {
  if (!pepper) throw new Error("crypto not initialised");
  return createHmac("sha256", pepper).update(waId.replace(/\D/g, "")).digest("base64url");
}

/** "919876543210" | "+91 98765 43210" | "9876543210" → "919876543210" (null if not a valid Indian mobile). */
export function normalizeIndianPhone(input: string): string | null {
  let d = input.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length !== 10 || !/^[6-9]/.test(d)) return null;
  return `91${d}`;
}

/** "919876543210" → "+91 98765 43210" */
export function displayPhone(waId: string): string {
  const d = waId.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) return `+91 ${d.slice(2, 7)} ${d.slice(7)}`;
  return `+${d}`;
}

/** "919876543210" → "+91 98xxx x3210" */
export function maskPhone(waId: string): string {
  const d = waId.replace(/\D/g, "");
  const local = d.length === 12 ? d.slice(2) : d;
  return `+91 ${local.slice(0, 2)}xxx x${local.slice(-4)}`;
}
