// Outbound message model + WhatsApp Cloud API payload builders with limit validation
// (docs/WHATSAPP_INTEGRATION.md §3).

export interface Button { id: string; title: string }
export interface ListRow { id: string; title: string; description?: string }
export interface ListSection { title: string; rows: ListRow[] }

export type OutMsg =
  | { kind: "text"; body: string; previewUrl?: boolean }
  | { kind: "buttons"; body: string; buttons: Button[]; footer?: string }
  | { kind: "list"; body: string; button: string; sections: ListSection[] }
  | { kind: "flow"; body: string; cta: string; flowId: string; flowToken: string; screen: string; data?: Record<string, unknown>; draft?: boolean }
  | { kind: "contact"; name: string; phone: string }
  | { kind: "cta_url"; body: string; displayText: string; url: string }
  | { kind: "template"; name: string; lang: string; bodyParams: string[]; quickReplyPayloads?: string[]; otpCode?: string };

export class MessageLimitError extends Error {}

const len = (s: string) => [...s].length;

export function validate(m: OutMsg): void {
  const fail = (why: string) => { throw new MessageLimitError(why); };
  switch (m.kind) {
    case "text":
      if (!m.body.trim()) fail("empty text");
      if (len(m.body) > 4096) fail("text > 4096");
      break;
    case "buttons":
      if (m.buttons.length < 1 || m.buttons.length > 3) fail("buttons must be 1..3");
      if (len(m.body) > 1024) fail("button body > 1024");
      for (const b of m.buttons) {
        if (len(b.title) > 20) fail(`button title > 20: ${b.title}`);
        if (b.id.length > 256) fail("button id > 256");
      }
      if (new Set(m.buttons.map((b) => b.id)).size !== m.buttons.length) fail("duplicate button ids");
      break;
    case "list": {
      const rows = m.sections.flatMap((s) => s.rows);
      if (rows.length < 1 || rows.length > 10) fail("list rows must be 1..10");
      if (len(m.button) > 20) fail("list button > 20");
      if (len(m.body) > 1024) fail("list body > 1024");
      for (const s of m.sections) if (len(s.title) > 24) fail("section title > 24");
      for (const r of rows) {
        if (len(r.title) > 24) fail(`row title > 24: ${r.title}`);
        if (r.description && len(r.description) > 72) fail("row description > 72");
        if (r.id.length > 200) fail("row id > 200");
      }
      break;
    }
    case "cta_url":
      if (len(m.displayText) > 20) fail("cta_url display text > 20");
      if (len(m.body) > 1024) fail("cta_url body > 1024");
      if (!/^https?:\/\//.test(m.url)) fail("cta_url url");
      break;
    case "flow":
      if (len(m.cta) > 20) fail("flow cta > 20");
      if (len(m.body) > 1024) fail("flow body > 1024");
      break;
    default:
      break;
  }
}

/** Graph API `messages` payload for a recipient wa_id. */
export function toCloudPayload(to: string, m: OutMsg): Record<string, unknown> {
  validate(m);
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to };
  switch (m.kind) {
    case "text":
      return { ...base, type: "text", text: { body: m.body, preview_url: m.previewUrl ?? false } };
    case "buttons":
      return {
        ...base, type: "interactive",
        interactive: {
          type: "button", body: { text: m.body }, ...(m.footer ? { footer: { text: m.footer } } : {}),
          action: { buttons: m.buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
        },
      };
    case "list":
      return { ...base, type: "interactive", interactive: { type: "list", body: { text: m.body }, action: { button: m.button, sections: m.sections } } };
    case "flow":
      return {
        ...base, type: "interactive",
        interactive: {
          type: "flow", body: { text: m.body },
          action: {
            name: "flow",
            parameters: {
              flow_message_version: "3", flow_id: m.flowId, flow_token: m.flowToken, flow_cta: m.cta, flow_action: "data_exchange",
              ...(m.draft ? { mode: "draft" } : {}), // unpublished form (before business verification): testers only
            },
          },
        },
      };
    case "cta_url":
      return { ...base, type: "interactive", interactive: { type: "cta_url", body: { text: m.body }, action: { name: "cta_url", parameters: { display_text: m.displayText, url: m.url } } } };
    case "contact":
      return { ...base, type: "contacts", contacts: [{ name: { formatted_name: m.name, first_name: m.name }, phones: [{ phone: m.phone, type: "WORK" }] }] };
    case "template":
      return {
        ...base, type: "template",
        template: {
          name: m.name, language: { code: m.lang },
          components: [
            ...(m.bodyParams.length ? [{ type: "body", parameters: m.bodyParams.map((t) => ({ type: "text", text: t })) }] : []),
            ...(m.quickReplyPayloads ?? []).map((p, i) => ({ type: "button", sub_type: "quick_reply", index: String(i), parameters: [{ type: "payload", payload: p }] })),
            // Authentication templates: the copy-code button must carry the same code (Meta rejects the send otherwise).
            ...(m.otpCode ? [{ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: m.otpCode }] }] : []),
          ],
        },
      };
  }
}

/** Plain-text rendering of any message (simulator, logs of copy IDs only). */
export function previewText(m: OutMsg): string {
  switch (m.kind) {
    case "text": return m.body;
    case "buttons": return `${m.body}\n${m.buttons.map((b) => `[${b.title}]`).join(" ")}`;
    case "list": return `${m.body}\n[${m.button}] ${m.sections.flatMap((s) => s.rows.map((r) => r.title)).join(", ")}`;
    case "flow": return `${m.body}\n[${m.cta}]`;
    case "cta_url": return `${m.body}\n[${m.displayText}] ${m.url}`;
    case "contact": return `Contact: ${m.name} ${m.phone}`;
    case "template": return `template:${m.name}(${m.bodyParams.join(" | ")})`;
  }
}
