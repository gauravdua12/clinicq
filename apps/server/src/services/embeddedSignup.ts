import { randomInt } from "node:crypto";
import { decrypt, encrypt } from "@clinicq/db";
import { TEMPLATES, templateComponents, type TemplateName } from "@clinicq/wa";
import type { Ctx } from "../context";
import { currentScope } from "../scope";
import { audit } from "./notify";
import { invalidateNumberCache } from "./tenancy";

// Connecting a customer clinic's own WhatsApp number (WhatsApp Embedded Signup, docs/META_ONBOARDING.md §C).
// The clinic signs in with Facebook in a Meta pop-up and picks or creates its WhatsApp Business Account and number.
// We get a one-time code and the account/number ids; we exchange the code for the clinic's business token (stored
// encrypted), subscribe to the account's messages, register the number, and submit the clinic's message templates.

export class SignupError extends Error {
  constructor(public code: "not_configured" | "not_customer_clinic" | "code_exchange_failed" | "number_not_found" | "number_in_use" | "graph_error", public detail?: string) { super(code); }
}

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...a) => fetch(...a);
/** Tests replace Meta's Graph API with a fake. */
export function setGraphFetch(f: Fetch | null): void { fetchImpl = f ?? ((...a) => fetch(...a)); }

interface GraphError { error?: { message?: string; code?: number; error_subcode?: number } }

async function graph<T>(ctx: Ctx, path: string, opts: { token?: string; method?: string; body?: Record<string, unknown>; query?: Record<string, string> } = {}): Promise<T> {
  const url = new URL(`https://graph.facebook.com/${ctx.env.WA_GRAPH_VERSION}/${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const res = await fetchImpl(url.toString(), {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.body ? { "content-type": "application/json" } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await res.json().catch(() => ({}))) as T & GraphError;
  if (!res.ok || j.error) throw new SignupError("graph_error", `${path.split("?")[0]}: ${j.error?.code ?? res.status} ${j.error?.message ?? ""}`.slice(0, 200));
  return j;
}

export function signupConfig(ctx: Ctx): { appId: string; configId: string; graphVersion: string } | null {
  return ctx.env.META_APP_ID && ctx.env.META_ES_CONFIG_ID ? { appId: ctx.env.META_APP_ID, configId: ctx.env.META_ES_CONFIG_ID, graphVersion: ctx.env.WA_GRAPH_VERSION } : null;
}

interface PhoneInfo { id: string; display_phone_number?: string; verified_name?: string; quality_rating?: string; name_status?: string; code_verification_status?: string; platform_type?: string; is_on_biz_app?: boolean; messaging_limit_tier?: string; throughput?: { level?: string } }
const PHONE_FIELDS = "id,display_phone_number,verified_name,quality_rating,name_status,code_verification_status,platform_type,is_on_biz_app,messaging_limit_tier";

export interface ConnectInput { code: string; wabaId: string; phoneNumberId: string; connectedBy?: string; coexistence?: boolean }

export async function connectWhatsApp(ctx: Ctx, input: ConnectInput, actorId: string | null): Promise<{ displayPhone: string | null; verifiedName: string | null; problems: string[] }> {
  const cfg = signupConfig(ctx);
  if (!cfg) throw new SignupError("not_configured");
  const clinicId = currentScope().clinicId;
  if (!clinicId) throw new SignupError("not_customer_clinic");

  // 1. The one-time code → the clinic's business token (never leaves the server; stored encrypted).
  let token: string;
  try {
    const r = await graph<{ access_token?: string }>(ctx, "oauth/access_token", { query: { client_id: cfg.appId, client_secret: ctx.env.META_APP_SECRET, code: input.code } });
    if (!r.access_token) throw new SignupError("code_exchange_failed");
    token = r.access_token;
  } catch (e) { throw e instanceof SignupError && e.code !== "graph_error" ? e : new SignupError("code_exchange_failed", (e as SignupError).detail); }

  // 2. The number really is in the account this token can manage.
  const phones = await graph<{ data?: PhoneInfo[] }>(ctx, `${input.wabaId}/phone_numbers`, { token, query: { fields: PHONE_FIELDS } });
  const phone = phones.data?.find((p) => p.id === input.phoneNumberId);
  if (!phone) throw new SignupError("number_not_found");
  const other = await ctx.db.waConnection.findUnique({ where: { phoneNumberId: input.phoneNumberId } });
  if (other && other.clinicId !== clinicId && other.status === "CONNECTED") throw new SignupError("number_in_use");

  const problems: string[] = [];
  // 3. Deliver this account's messages to our webhook.
  await graph(ctx, `${input.wabaId}/subscribed_apps`, { token, body: {} }).catch((e: SignupError) => problems.push(`subscribe: ${e.detail ?? e.code}`));
  // 4. Register the number for the Cloud API (not for a number that stays on the WhatsApp Business app: coexistence).
  let pin: string | null = null;
  if (!(input.coexistence || phone.is_on_biz_app)) {
    pin = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await graph(ctx, `${input.phoneNumberId}/register`, { token, body: { messaging_product: "whatsapp", pin } }).catch((e: SignupError) => { problems.push(`register: ${e.detail ?? e.code}`); pin = null; });
  }
  const data = {
    wabaId: input.wabaId, phoneNumberId: input.phoneNumberId, displayPhone: phone.display_phone_number ?? null, verifiedName: phone.verified_name ?? null,
    token: encrypt(token), pin: pin ? encrypt(pin) : null, status: "CONNECTED", connectedBy: input.connectedBy?.slice(0, 80) ?? null, connectedAt: ctx.clock.now(),
    health: { problems } as never,
  };
  if (other && other.clinicId !== clinicId) await ctx.db.waConnection.delete({ where: { clinicId: other.clinicId } }); // a stale, disconnected record of this number
  await ctx.db.waConnection.upsert({ where: { clinicId }, create: { clinicId, ...data }, update: data });
  invalidateNumberCache();
  ctx.wa.invalidate(clinicId);
  await audit(ctx, "DOCTOR", actorId, "whatsapp.connect", "WaConnection", clinicId, { wabaId: input.wabaId, phoneNumberId: input.phoneNumberId, problems: problems.length });
  // 5. The clinic's message templates, then a status check (in the background; Meta takes minutes to approve).
  await ctx.jobs.schedule("waTemplates", {}, ctx.clock.now(), `wa-templates:${clinicId}`);
  return { displayPhone: data.displayPhone, verifiedName: data.verifiedName, problems };
}

/** Submit every Q-Incolo template (English and Hindi) to the clinic's account; existing ones are left as they are. */
export async function submitTemplates(ctx: Ctx): Promise<{ created: number; failed: string[] }> {
  const conn = await connection(ctx);
  if (!conn) return { created: 0, failed: [] };
  const token = decrypt(conn.token);
  const existing = await graph<{ data?: { name: string; language: string }[] }>(ctx, `${conn.wabaId}/message_templates`, { token, query: { fields: "name,language,status", limit: "200" } });
  const have = new Set((existing.data ?? []).map((t) => `${t.name}/${t.language}`));
  const base = `${ctx.env.PUBLIC_BASE_URL}${ctx.env.BASE_PATH}`;
  let created = 0;
  const failed: string[] = [];
  for (const [key, def] of Object.entries(TEMPLATES) as [TemplateName, (typeof TEMPLATES)[TemplateName]][]) {
    if (key === "staff_login_otp") {
      if (have.has("staff_login_otp/en")) continue;
      await graph(ctx, `${conn.wabaId}/message_templates`, { token, body: { name: def.name, language: "en", category: "AUTHENTICATION", components: [{ type: "BODY", add_security_recommendation: true }, { type: "FOOTER", code_expiration_minutes: 5 }, { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE" }] }] } })
        .then(() => created++, () => failed.push("staff_login_otp/en"));
      continue;
    }
    for (const lang of ["en", "hi"] as const) {
      if (have.has(`${def.name}/${lang}`)) continue;
      await graph(ctx, `${conn.wabaId}/message_templates`, { token, body: { name: def.name, language: lang, category: def.category, components: templateComponents(key, lang, base) } })
        .then(() => created++, () => failed.push(`${def.name}/${lang}`));
    }
  }
  return { created, failed };
}

export interface WaHealth {
  phone: { displayPhone: string | null; verifiedName: string | null; nameStatus: string | null; quality: string | null; limit: string | null; coexistence: boolean } | null;
  templates: { approved: number; pending: number; rejected: number; missing: number };
  problems: string[];
}

/** Read the number's and templates' status from Meta and keep it for the Settings page. */
export async function checkConnection(ctx: Ctx): Promise<WaHealth | null> {
  const conn = await connection(ctx);
  if (!conn) return null;
  const token = decrypt(conn.token);
  const problems: string[] = [];
  const phone = await graph<PhoneInfo>(ctx, conn.phoneNumberId, { token, query: { fields: PHONE_FIELDS } }).catch((e: SignupError) => { problems.push(`number: ${e.detail ?? e.code}`); return null; });
  const tpl = await graph<{ data?: { name: string; language: string; status: string }[] }>(ctx, `${conn.wabaId}/message_templates`, { token, query: { fields: "name,language,status", limit: "200" } })
    .catch((e: SignupError) => { problems.push(`templates: ${e.detail ?? e.code}`); return { data: [] }; });
  const ours = new Set(Object.values(TEMPLATES).flatMap((d) => (d.category === "AUTHENTICATION" ? [`${d.name}/en`] : [`${d.name}/en`, `${d.name}/hi`])));
  const mine = (tpl.data ?? []).filter((t) => ours.has(`${t.name}/${t.language}`));
  const count = (s: string[]) => mine.filter((t) => s.includes(t.status)).length;
  const health: WaHealth = {
    phone: phone ? { displayPhone: phone.display_phone_number ?? null, verifiedName: phone.verified_name ?? null, nameStatus: phone.name_status ?? null, quality: phone.quality_rating ?? null, limit: phone.messaging_limit_tier ?? null, coexistence: !!phone.is_on_biz_app } : null,
    templates: { approved: count(["APPROVED"]), pending: count(["PENDING", "IN_APPEAL"]), rejected: count(["REJECTED", "PAUSED", "DISABLED"]), missing: Math.max(0, ours.size - mine.length) },
    problems,
  };
  await ctx.db.waConnection.update({ where: { clinicId: conn.clinicId }, data: { health: health as never, checkedAt: ctx.clock.now(), ...(phone?.display_phone_number ? { displayPhone: phone.display_phone_number, verifiedName: phone.verified_name ?? conn.verifiedName } : {}) } });
  return health;
}

/** Stop using the clinic's number: unsubscribe, forget the token now (the ids go with the 30-day purge). */
export async function disconnectWhatsApp(ctx: Ctx, actorId: string | null): Promise<void> {
  const conn = await connection(ctx);
  if (!conn) return;
  await graph(ctx, `${conn.wabaId}/subscribed_apps`, { token: decrypt(conn.token), method: "DELETE" }).catch((e) => ctx.log.warn({ err: e }, "wa_unsubscribe_failed"));
  await ctx.db.waConnection.update({ where: { clinicId: conn.clinicId }, data: { status: "DISCONNECTED", token: "", pin: null, checkedAt: ctx.clock.now() } });
  invalidateNumberCache();
  ctx.wa.invalidate(conn.clinicId);
  await audit(ctx, "DOCTOR", actorId, "whatsapp.disconnect", "WaConnection", conn.clinicId);
}

async function connection(ctx: Ctx) {
  const clinicId = currentScope().clinicId;
  if (!clinicId) return null;
  const conn = await ctx.db.waConnection.findUnique({ where: { clinicId } });
  return conn?.status === "CONNECTED" ? conn : null;
}
