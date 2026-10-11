import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { toCloudPayload, validate, type OutMsg } from "./messages";

// WhatsApp transport (docs/WHATSAPP_INTEGRATION.md §3–4, §7).

export interface SendResult { wamid: string }

export interface WhatsAppClient {
  send(to: string, msg: OutMsg): Promise<SendResult>;
  /** Voice notes only — returns audio bytes in memory (never written to disk). */
  downloadMedia(mediaId: string, maxBytes: number): Promise<{ data: Buffer; mime: string }>;
  markRead(wamid: string): Promise<void>;
}

export class WhatsAppApiError extends Error {
  constructor(public status: number, public code?: number) { super(`whatsapp_api_${status}${code ? `_${code}` : ""}`); }
}

export class CloudApiClient implements WhatsAppClient {
  constructor(private opts: { token: string; phoneNumberId: string; graphVersion: string }) {}
  private url(path: string) { return `https://graph.facebook.com/${this.opts.graphVersion}/${path}`; }

  async send(to: string, msg: OutMsg): Promise<SendResult> {
    const res = await fetch(this.url(`${this.opts.phoneNumberId}/messages`), {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" },
      body: JSON.stringify(toCloudPayload(to, msg)),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { code?: number } };
    if (!res.ok) throw new WhatsAppApiError(res.status, body.error?.code);
    return { wamid: body.messages?.[0]?.id ?? "" };
  }

  async downloadMedia(mediaId: string, maxBytes: number): Promise<{ data: Buffer; mime: string }> {
    const meta = await fetch(this.url(mediaId), { headers: { authorization: `Bearer ${this.opts.token}` }, signal: AbortSignal.timeout(10_000) });
    if (!meta.ok) throw new WhatsAppApiError(meta.status);
    const m = (await meta.json()) as { url: string; mime_type: string; file_size?: number };
    if (m.file_size && m.file_size > maxBytes) throw new WhatsAppApiError(413);
    const bin = await fetch(m.url, { headers: { authorization: `Bearer ${this.opts.token}` }, signal: AbortSignal.timeout(20_000) });
    if (!bin.ok) throw new WhatsAppApiError(bin.status);
    const data = Buffer.from(await bin.arrayBuffer());
    if (data.length > maxBytes) throw new WhatsAppApiError(413);
    return { data, mime: m.mime_type };
  }

  async markRead(wamid: string): Promise<void> {
    await fetch(this.url(`${this.opts.phoneNumberId}/messages`), {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: wamid }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
  }
}

export interface MockOutbound { id: string; to: string; msg: OutMsg; at: number }

/** In-memory WhatsApp used in dev (simulator) and tests. */
export class MockWhatsApp extends EventEmitter implements WhatsAppClient {
  readonly sent: MockOutbound[] = [];
  readonly media = new Map<string, { data: Buffer; mime: string }>();
  readonly mediaDownloads: string[] = [];
  failNext = 0;

  async send(to: string, msg: OutMsg): Promise<SendResult> {
    validate(msg);
    if (this.failNext > 0) { this.failNext--; throw new WhatsAppApiError(500); }
    const id = `wamid.mock.${randomUUID()}`;
    const rec = { id, to, msg, at: Date.now() };
    this.sent.push(rec);
    this.emit("outbound", rec);
    return { wamid: id };
  }

  async downloadMedia(mediaId: string): Promise<{ data: Buffer; mime: string }> {
    this.mediaDownloads.push(mediaId);
    const m = this.media.get(mediaId);
    if (!m) throw new WhatsAppApiError(404);
    return m;
  }

  async markRead(): Promise<void> {}

  to(waId: string): OutMsg[] { return this.sent.filter((s) => s.to === waId).map((s) => s.msg); }
  last(waId: string): OutMsg | undefined { return this.to(waId).at(-1); }
  clear(): void { this.sent.length = 0; this.mediaDownloads.length = 0; this.media.clear(); }
}
