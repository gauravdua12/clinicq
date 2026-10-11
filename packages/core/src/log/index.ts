import pino, { type DestinationStream, type Logger } from "pino";

// Redacting logger (docs/DATA_POLICY.md §4.3). Never log message text, transcripts, names or phones.
export const REDACT_KEYS = ["text", "body", "caption", "transcript", "message", "content", "phone", "waPhone", "wa_id", "from", "name", "profileName", "displayName", "contactPhone", "input", "prompt"];
const MOBILE = /(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/g;

function scrub(v: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]";
  if (typeof v === "string") return v.replace(MOBILE, "[phone]");
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  if (v && typeof v === "object") {
    if (v instanceof Error) return { name: v.name, code: (v as { code?: string }).code };
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = REDACT_KEYS.includes(k) ? "[redacted]" : scrub(val, depth + 1);
    return out;
  }
  return v;
}

export function createLogger(opts: { level?: string; destination?: DestinationStream } = {}): Logger {
  return pino(
    {
      level: opts.level ?? process.env.LOG_LEVEL ?? "info",
      base: undefined,
      hooks: {
        logMethod(args, method) {
          const scrubbed = args.map((a) => (typeof a === "string" ? a.replace(MOBILE, "[phone]") : scrub(a))) as Parameters<typeof method>;
          return method.apply(this, scrubbed);
        },
      },
      serializers: { err: (e: Error) => ({ name: e?.name, code: (e as { code?: string })?.code, status: (e as { status?: number })?.status }) },
    },
    opts.destination,
  );
}

export type { Logger };
