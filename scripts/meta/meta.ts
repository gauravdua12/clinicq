/**
 * Meta WhatsApp setup helper (docs/META_ONBOARDING.md). Uses env from .env:
 *   WA_ACCESS_TOKEN, WA_PHONE_NUMBER_ID, WA_BUSINESS_ACCOUNT_ID, WA_GRAPH_VERSION, PUBLIC_BASE_URL, BASE_PATH
 *
 *   npm run meta -- check                      number status, display name, quality, templates
 *   npm run meta -- register --pin 123456      register the number on Cloud API (sets the 2-step PIN)
 *   npm run meta -- webhook                    set the app's callback URL (PUBLIC_BASE_URL+BASE_PATH/webhook) + verify token
 *   npm run meta -- subscribe                  subscribe this app to the WABA's webhooks
 *   npm run meta -- templates                  create all ClinicQ templates (EN + HI), skips existing
 *   npm run meta -- flow                       upload Flow public key, create + publish the booking Flow
 *   npm run meta -- send-test --to 9198xxxxxx  send Meta's hello_world template
 */
import { existsSync, readFileSync } from "node:fs";
import { TEMPLATES, TEMPLATE_TEXT, templateComponents } from "../../packages/wa/src/index";

for (const f of [".env"]) if (existsSync(f)) process.loadEnvFile(f);
const V = process.env.WA_GRAPH_VERSION ?? "v23.0";
const TOKEN = process.env.WA_ACCESS_TOKEN ?? "";
const PNID = process.env.WA_PHONE_NUMBER_ID ?? "";
const WABA = process.env.WA_BUSINESS_ACCOUNT_ID ?? "";
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };

async function g(path: string, init: { method?: string; body?: unknown; form?: FormData } = {}): Promise<Record<string, unknown>> {
  const res = await fetch(`https://graph.facebook.com/${V}/${path}`, {
    method: init.method ?? (init.body || init.form ? "POST" : "GET"),
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.body ? { "content-type": "application/json" } : {}) },
    body: init.form ?? (init.body ? JSON.stringify(init.body) : undefined),
  });
  const j = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(j.error ?? j)}`);
  return j;
}

function need(...vars: [string, string][]) {
  const missing = vars.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) { console.error(`Set ${missing.join(", ")} in .env first.`); process.exit(1); }
}

const cmd = process.argv[2];
need(["WA_ACCESS_TOKEN", TOKEN]);
if (cmd === "check") {
  need(["WA_BUSINESS_ACCOUNT_ID", WABA]);
  const nums = await g(`${WABA}/phone_numbers?fields=display_phone_number,verified_name,name_status,quality_rating,code_verification_status,platform_type,throughput,messaging_limit_tier`);
  console.log("Phone numbers:", JSON.stringify(nums.data, null, 1));
  const t = await g(`${WABA}/message_templates?fields=name,language,status,category&limit=100`);
  console.log("Templates:", (t.data as { name: string; language: string; status: string }[]).map((x) => `${x.name}/${x.language}: ${x.status}`).join("\n"));
} else if (cmd === "register") {
  need(["WA_PHONE_NUMBER_ID", PNID]);
  const pin = arg("--pin");
  if (!pin || !/^\d{6}$/.test(pin)) { console.error("Use --pin <6 digits> (this becomes the number's two-step verification PIN — store it safely)."); process.exit(1); }
  console.log(await g(`${PNID}/register`, { body: { messaging_product: "whatsapp", pin } }));
} else if (cmd === "webhook") {
  // App-level webhook: callback URL + verify token + the "messages" field (Meta calls GET /webhook to verify first).
  const appId = process.env.META_APP_ID ?? "", secret = process.env.META_APP_SECRET ?? "", verify = process.env.META_VERIFY_TOKEN ?? "";
  need(["META_APP_ID", appId], ["META_APP_SECRET", secret], ["META_VERIFY_TOKEN", verify]);
  const callback = `${process.env.PUBLIC_BASE_URL ?? ""}${process.env.BASE_PATH ?? ""}/webhook`;
  if (!callback.startsWith("https://")) { console.error(`Callback must be https (got ${callback}); set PUBLIC_BASE_URL and BASE_PATH.`); process.exit(1); }
  const form = new URLSearchParams({ object: "whatsapp_business_account", callback_url: callback, verify_token: verify, fields: "messages", include_values: "true", access_token: `${appId}|${secret}` });
  const r = await fetch(`https://graph.facebook.com/${V}/${appId}/subscriptions`, { method: "POST", body: form });
  console.log(r.status, await r.text(), "→", callback);
  const list = await fetch(`https://graph.facebook.com/${V}/${appId}/subscriptions?access_token=${encodeURIComponent(`${appId}|${secret}`)}`);
  console.log("Subscriptions:", await list.text());
} else if (cmd === "subscribe") {
  need(["WA_BUSINESS_ACCOUNT_ID", WABA]);
  console.log(await g(`${WABA}/subscribed_apps`, { body: {} }));
} else if (cmd === "templates") {
  need(["WA_BUSINESS_ACCOUNT_ID", WABA]);
  const rows = (await g(`${WABA}/message_templates?fields=id,name,language,status&limit=200`)).data as { id: string; name: string; language: string; status: string }[];
  const existing = new Map(rows.map((t) => [`${t.name}/${t.language}`, t]));
  for (const [name, def] of Object.entries(TEMPLATES)) {
    if (name === "staff_login_otp") {
      if (!existing.has(`${name}/en`)) {
        const r = await g(`${WABA}/message_templates`, { body: { name, language: "en", category: "AUTHENTICATION", components: [{ type: "BODY", add_security_recommendation: true }, { type: "FOOTER", code_expiration_minutes: 5 }, { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE" }] }] } }).catch((e) => ({ error: String(e) }));
        console.log(name, "en →", JSON.stringify(r));
      }
      continue;
    }
    for (const lang of ["en", "hi"] as const) {
      const components = templateComponents(name as keyof typeof TEMPLATE_TEXT, lang, `${process.env.PUBLIC_BASE_URL ?? ""}${process.env.BASE_PATH ?? ""}`);
      const metaName = def.name; // may differ from our key (e.g. a template renamed after a rejection)
      const cur = existing.get(`${metaName}/${lang}`);
      if (cur && cur.status !== "REJECTED") { console.log(`${metaName}/${lang}: ${cur.status}`); continue; }
      // A rejected template is edited in place (its name can't be reused for a new one).
      const r = cur
        ? await g(cur.id, { body: { category: def.category, components } }).then((x) => ({ ...x, edited: true })).catch((e) => ({ error: String(e) }))
        : await g(`${WABA}/message_templates`, { body: { name: metaName, language: lang, category: def.category, components } }).catch((e) => ({ error: String(e) }));
      console.log(`${metaName}/${lang} →`, JSON.stringify(r));
    }
  }
} else if (cmd === "flow") {
  need(["WA_BUSINESS_ACCOUNT_ID", WABA], ["WA_PHONE_NUMBER_ID", PNID]);
  const pub = readFileSync(arg("--public-key") ?? ".flow-dev-keys/public.pem", "utf8");
  console.log("public key:", await g(`${PNID}/whatsapp_business_encryption`, { form: (() => { const f = new FormData(); f.append("business_public_key", pub); return f; })() }));
  const endpoint = `${process.env.PUBLIC_BASE_URL}${process.env.BASE_PATH ?? ""}/flow`;
  const created = await g(`${WABA}/flows`, { body: { name: "clinicq_booking", categories: ["APPOINTMENT_BOOKING"], endpoint_uri: endpoint } });
  const id = String(created.id);
  const f = new FormData();
  f.append("file", new Blob([readFileSync("packages/wa/flows/booking.json")], { type: "application/json" }), "flow.json");
  f.append("name", "flow.json");
  f.append("asset_type", "FLOW_JSON");
  console.log("asset:", await g(`${id}/assets`, { form: f }));
  console.log("publish:", await g(`${id}/publish`, { body: {} }).catch((e) => `not published yet: ${e} (fix validation errors in WhatsApp Manager → Flows, then publish)`));
  console.log(`Set WA_FLOW_ID_BOOKING=${id} in the server env.`);
} else if (cmd === "send-test") {
  need(["WA_PHONE_NUMBER_ID", PNID]);
  const to = (arg("--to") ?? "").replace(/\D/g, "");
  console.log(await g(`${PNID}/messages`, { body: { messaging_product: "whatsapp", to, type: "template", template: { name: "hello_world", language: { code: "en_US" } } } }));
} else {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]);
}
