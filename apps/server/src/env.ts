import { existsSync } from "node:fs";
import { z } from "zod";

// All configuration from env, validated at boot (docs/ARCHITECTURE.md §7).

const bool = z.union([z.boolean(), z.string()]).transform((v) => v === true || v === "true" || v === "1");

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(8080),
  PUBLIC_BASE_URL: z.string().default("http://localhost:8080"),
  BASE_PATH: z.string().regex(/^(\/[a-z0-9-]+)?$/).default(""), // e.g. "/clinicq" when sharing app.incolo.si
  WEB_DEV_ORIGIN: z.string().optional(),
  DATABASE_URL: z.string(),
  CLINIC_TZ: z.string().default("Asia/Kolkata"),
  WA_MODE: z.enum(["mock", "cloud"]).default("mock"),
  META_APP_SECRET: z.string().min(1),
  META_VERIFY_TOKEN: z.string().min(1),
  WA_ACCESS_TOKEN: z.string().optional(),
  WA_PHONE_NUMBER_ID: z.string().optional(),
  WA_GRAPH_VERSION: z.string().default("v23.0"),
  WA_FLOW_ID_BOOKING: z.string().optional(),
  WA_FLOW_MODE: z.enum(["published", "draft"]).default("published"),
  BOOKING_PAGE: bool.default(true), // form D as a page opened from WhatsApp (preferred over the native Flow)
  FLOW_PRIVATE_KEY_PATH: z.string().optional(),
  FLOW_PRIVATE_KEY_PASSPHRASE: z.string().optional(),
  AWS_REGION: z.string().default("ap-south-1"),
  EXTRACTOR_PRIMARY: z.string().default("rules"),
  EXTRACTOR_ESCALATION: z.string().default(""),
  EXTRACTOR_TIMEOUT_MS: z.coerce.number().default(3500),
  EXTRACTOR_MIN_CONFIDENCE: z.coerce.number().default(0.7),
  OPENAI_COMPAT_BASE_URL: z.string().optional(),
  OPENAI_COMPAT_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  STT_PROVIDER: z.string().default("mock"),
  STT_FALLBACK: z.string().default(""),
  SARVAM_API_KEY: z.string().optional(),
  DATA_KEY: z.string().min(40),
  HASH_PEPPER: z.string().min(20),
  SESSION_SECRET: z.string().min(20),
  DEV_TOOLS: bool.default(false),
  DEMO_STUDIO: bool.default(false),
  WA_DISPLAY_NUMBER: z.string().default(""), // the WhatsApp number patients message, e.g. 919920323832
  DEMO_PRESENTER_PHONES: z.string().default(""),
  // Meta App Review: a made-up staff number whose login code is fixed (never sent on WhatsApp). Empty code = switched off.
  REVIEWER_PHONE: z.string().default(""),
  REVIEWER_CODE: z.string().regex(/^(\d{6})?$/, "REVIEWER_CODE must be 6 digits").default(""),
  GRIEVANCE_OFFICER: z.string().default("Gaurav Dua"), // named on the policy pages and in the "privacy" reply (IT Rules 2011, rule 5(9))
  GRIEVANCE_EMAIL: z.string().email().default("customercare@incolosystems.com"), // privacy questions and complaints (policy pages, "privacy" in chat)
  INCOLO_ADMIN_PHONES: z.string().default(""), // Incolo's internal admins: language model settings, Demo Studio (never clinic staff)
  JOB_POLL_MS: z.coerce.number().default(15000),
  HOST: z.string().default("0.0.0.0"), // 127.0.0.1 behind a local reverse proxy
  STALE_INBOUND_MIN: z.coerce.number().default(30), // older messages (Meta re-deliveries after downtime) are not acted on
});
export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(overrides: Record<string, string | undefined> = {}): Env {
  // Tests configure env explicitly (test/setup-env.ts) and must never pick up live settings from .env.
  if (process.env.NODE_ENV !== "test") for (const f of [".env", "../../.env"]) if (existsSync(f)) { try { process.loadEnvFile(f); } catch { /* ignore */ } break; }
  const parsed = EnvSchema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const keys = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid environment: ${keys}`);
  }
  if (parsed.data.NODE_ENV === "production" && parsed.data.DEV_TOOLS) throw new Error("DEV_TOOLS must be off in production");
  return parsed.data;
}
