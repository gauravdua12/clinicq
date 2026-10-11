import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// Inbound webhook parsing + signature verification (docs/WHATSAPP_INTEGRATION.md §2).

export function signBody(rawBody: Buffer | string, appSecret: string): string {
  return "sha256=" + createHmac("sha256", appSecret).update(rawBody).digest("hex");
}

export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(signBody(rawBody, appSecret));
  const got = Buffer.from(header);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

const Msg = z.object({
  id: z.string(),
  from: z.string(),
  timestamp: z.string().optional(),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
  button: z.object({ text: z.string().optional(), payload: z.string().optional() }).optional(),
  interactive: z
    .object({
      type: z.string(),
      button_reply: z.object({ id: z.string(), title: z.string().optional() }).optional(),
      list_reply: z.object({ id: z.string(), title: z.string().optional() }).optional(),
      nfm_reply: z.object({ response_json: z.string(), name: z.string().optional() }).optional(),
    })
    .optional(),
  audio: z.object({ id: z.string(), mime_type: z.string().optional(), voice: z.boolean().optional() }).optional(),
  image: z.object({ id: z.string() }).optional(),
  document: z.object({ id: z.string() }).optional(),
  video: z.object({ id: z.string() }).optional(),
  sticker: z.object({ id: z.string() }).optional(),
}).passthrough();

const Status = z.object({
  id: z.string(),
  status: z.string(),
  recipient_id: z.string().optional(),
  errors: z.array(z.object({ code: z.number().optional() }).passthrough()).optional(),
}).passthrough();

const Payload = z.object({
  object: z.string().optional(),
  entry: z.array(z.object({
    changes: z.array(z.object({
      value: z.object({
        metadata: z.object({ phone_number_id: z.string().optional() }).passthrough().optional(),
        contacts: z.array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string().optional() }).optional() })).optional(),
        messages: z.array(Msg).optional(),
        statuses: z.array(Status).optional(),
      }).passthrough(),
    }).passthrough()),
  }).passthrough()),
}).passthrough();

export type InboundKind = "text" | "button" | "flow" | "audio" | "media" | "location" | "reaction" | "unsupported";

export interface InboundMessage {
  wamid: string;
  from: string; // wa_id digits
  profileName?: string;
  timestamp?: number;
  kind: InboundKind;
  text?: string; // in memory only — never persisted
  buttonId?: string; // interactive reply id or template quick-reply payload
  buttonTitle?: string;
  flowResponse?: Record<string, unknown>;
  mediaId?: string;
  mediaType?: string;
  isVoice?: boolean;
}

export interface StatusUpdate { wamid: string; status: string; errorCode?: number }

export function parseWebhook(json: unknown): { messages: InboundMessage[]; statuses: StatusUpdate[] } {
  const p = Payload.safeParse(json);
  if (!p.success) return { messages: [], statuses: [] };
  const messages: InboundMessage[] = [];
  const statuses: StatusUpdate[] = [];
  for (const e of p.data.entry) for (const c of e.changes) {
    const v = c.value;
    const names = new Map((v.contacts ?? []).map((k) => [k.wa_id, k.profile?.name]));
    for (const m of v.messages ?? []) {
      const base = { wamid: m.id, from: m.from, profileName: names.get(m.from) ?? undefined, timestamp: m.timestamp ? Number(m.timestamp) : undefined };
      if (m.type === "text" && m.text) messages.push({ ...base, kind: "text", text: m.text.body });
      else if (m.type === "interactive" && m.interactive?.button_reply) messages.push({ ...base, kind: "button", buttonId: m.interactive.button_reply.id, buttonTitle: m.interactive.button_reply.title });
      else if (m.type === "interactive" && m.interactive?.list_reply) messages.push({ ...base, kind: "button", buttonId: m.interactive.list_reply.id, buttonTitle: m.interactive.list_reply.title });
      else if (m.type === "interactive" && m.interactive?.nfm_reply) {
        let fr: Record<string, unknown> = {};
        try { fr = JSON.parse(m.interactive.nfm_reply.response_json); } catch { /* ignore */ }
        messages.push({ ...base, kind: "flow", flowResponse: fr });
      } else if (m.type === "button" && m.button) messages.push({ ...base, kind: "button", buttonId: m.button.payload ?? m.button.text, buttonTitle: m.button.text });
      else if (m.type === "audio" && m.audio) messages.push({ ...base, kind: "audio", mediaId: m.audio.id, mediaType: m.audio.mime_type, isVoice: m.audio.voice ?? true });
      else if (["image", "document", "video", "sticker"].includes(m.type)) messages.push({ ...base, kind: "media", mediaType: m.type });
      else if (m.type === "location") messages.push({ ...base, kind: "location" });
      else if (m.type === "reaction") messages.push({ ...base, kind: "reaction" });
      else messages.push({ ...base, kind: "unsupported" });
    }
    for (const s of v.statuses ?? []) statuses.push({ wamid: s.id, status: s.status, errorCode: s.errors?.[0]?.code });
  }
  return { messages, statuses };
}

/** Build a Meta-format webhook body (used by the simulator and tests). */
export function buildWebhook(opts: { from: string; name?: string; wamid: string; message: Record<string, unknown> }): Record<string, unknown> {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "WABA", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp",
      metadata: { phone_number_id: "PNID" },
      contacts: [{ wa_id: opts.from, profile: { name: opts.name ?? "" } }],
      messages: [{ id: opts.wamid, from: opts.from, timestamp: String(Math.floor(Date.now() / 1000)), ...opts.message }],
    } }] }],
  };
}
