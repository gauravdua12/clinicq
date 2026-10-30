import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decrypt, phoneHash } from "@clinicq/db";
import { buildWebhook, signBody, TEMPLATES } from "@clinicq/wa";
import { harness, type H } from "../harness";
import { createCustomerClinic } from "../../src/services/customers";
import { setGraphFetch } from "../../src/services/embeddedSignup";
import { invalidateNumberCache } from "../../src/services/tenancy";

// A customer clinic connects its own WhatsApp number (Embedded Signup): code exchange, checks, webhook subscription,
// registration, templates, status, disconnect. Meta's Graph API is faked; nothing leaves the machine.

let h: H;
let calls: { method: string; path: string; body?: Record<string, unknown>; auth?: string; query: Record<string, string> }[] = [];
let phones: { id: string; display_phone_number: string; verified_name: string; is_on_biz_app?: boolean }[];
let exchangeOk = true;
const WABA = "1098765432100";
const PNID = "1234567890123";
const DOC = "919876500011";

function fakeGraph(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v[\d.]+\//, "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path, body, auth: (init?.headers as Record<string, string> | undefined)?.authorization, query: Object.fromEntries(url.searchParams) });
    const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json" } });
    if (path === "oauth/access_token") return exchangeOk ? ok({ access_token: "EAAclinic-business-token" }) : new Response(JSON.stringify({ error: { code: 100, message: "Invalid code" } }), { status: 400 });
    if (path === `${WABA}/phone_numbers`) return ok({ data: phones });
    if (path === `${WABA}/subscribed_apps`) return ok({ success: true });
    if (path === `${PNID}/register`) return ok({ success: true });
    if (path === `${WABA}/message_templates`) return ok(init?.method === "POST" ? { id: randomUUID(), status: "PENDING", category: "UTILITY" } : { data: [{ name: "booking_confirmation", language: "en", status: "APPROVED" }] });
    if (path === PNID) return ok({ ...phones[0], name_status: "APPROVED", quality_rating: "GREEN", messaging_limit_tier: "TIER_250" });
    return new Response(JSON.stringify({ error: { message: `unexpected ${path}` } }), { status: 404 });
  }) as typeof fetch;
}

beforeEach(async () => {
  process.env.META_APP_ID = "2655971144875702";
  process.env.META_ES_CONFIG_ID = "1454298736672568";
  h = await harness({ start: "2026-10-09T12:00:00+05:30" });
  invalidateNumberCache(); h.ctx.wa.invalidate();
  calls = []; exchangeOk = true;
  phones = [{ id: PNID, display_phone_number: "+91 98111 22333", verified_name: "Sunrise Child Clinic" }];
  setGraphFetch(fakeGraph());
  await createCustomerClinic(h.ctx, { clinicName: "Sunrise Child Clinic", doctorName: "Dr. Mehta", doctorPhone: DOC, addressShort: "Baner, Pune", clinicPhone: "+91 20 4000 5555" }, null);
});
afterEach(async () => { setGraphFetch(null); delete process.env.META_APP_ID; delete process.env.META_ES_CONFIG_ID; await h?.close(); });

async function sidFor(phone: string): Promise<string> {
  const staff = await h.db.staffUser.findUniqueOrThrow({ where: { phoneHash: phoneHash(phone) } });
  const sid = randomUUID();
  await h.db.staffSession.create({ data: { id: createHash("sha256").update(sid).digest("hex"), staffId: staff.id, expiresAt: new Date("2030-01-01") } });
  return sid;
}
const api = (sid: string, method: "GET" | "POST", url: string, payload?: object) => h.app.inject({ method, url, cookies: { sid }, ...(payload ? { payload } : {}) });
const connect = (sid: string, extra: object = {}) => api(sid, "POST", "/api/whatsapp/connect", { code: "AQD-one-time-code-123", wabaId: WABA, phoneNumberId: PNID, connectedBy: "Anil Mehta", ...extra });

describe("connecting a customer clinic's own WhatsApp number", () => {
  it("before: the Settings tab offers Connect with the app's signup configuration", async () => {
    const sid = await sidFor(DOC);
    expect((await api(sid, "GET", "/api/whatsapp")).json()).toEqual({ ownNumber: true, signup: { appId: "2655971144875702", configId: "1454298736672568", graphVersion: "v23.0" }, connection: null });
  });

  it("connects: token kept encrypted on the server, webhook subscribed, number registered, templates submitted, then messages flow on it", async () => {
    const sid = await sidFor(DOC);
    const r = await connect(sid);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ connection: { displayPhone: "+91 98111 22333", verifiedName: "Sunrise Child Clinic", connectedBy: "Anil Mehta" }, problems: [] });
    expect(JSON.stringify(r.json())).not.toContain("EAAclinic"); // the token never goes back to the browser
    expect(r.json().connection.health).toBeNull(); // no status from Meta yet: the page shows "checking", never half a status

    const ex = calls.find((c) => c.path === "oauth/access_token")!;
    expect(ex.query).toMatchObject({ client_id: "2655971144875702", code: "AQD-one-time-code-123" });
    expect(ex.query.client_secret).toBeTruthy();
    expect(calls.find((c) => c.path === `${WABA}/subscribed_apps`)).toMatchObject({ method: "POST", auth: "Bearer EAAclinic-business-token" });
    expect(calls.find((c) => c.path === `${PNID}/register`)?.body).toMatchObject({ messaging_product: "whatsapp", pin: expect.stringMatching(/^\d{6}$/) });
    const conn = await h.db.waConnection.findFirstOrThrow();
    expect(conn.token).not.toContain("EAAclinic");
    expect(decrypt(conn.token)).toBe("EAAclinic-business-token");

    await h.runJobs();
    const posted = calls.filter((c) => c.path === `${WABA}/message_templates` && c.method === "POST");
    const expected = Object.keys(TEMPLATES).length * 2 - 1 /* auth: English only */ - 1 /* booking_confirmation/en exists */;
    expect(posted).toHaveLength(expected);
    // the status check runs straight after the templates go in
    expect(((await api(sid, "GET", "/api/whatsapp")).json() as { connection: { health: { templates: { approved: number } } } }).connection.health.templates).toBeTruthy();
    const pay = posted.find((c) => c.body?.name === "payment_due" && c.body.language === "en")!;
    expect(JSON.stringify(pay.body)).toContain("/pay?t={{1}}");

    // a patient messages the clinic's number: answered by this clinic, from this number
    const payload = JSON.stringify(buildWebhook({ from: "919812300009", wamid: `wamid.t.${randomUUID()}`, message: { type: "text", text: { body: "Hi" } }, phoneNumberId: PNID }));
    await h.app.inject({ method: "POST", url: "/webhook", headers: { "content-type": "application/json", "x-hub-signature-256": signBody(payload, h.ctx.env.META_APP_SECRET) }, payload });
    const out = h.wa.sent.filter((s) => s.to === "919812300009");
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((s) => s.via === PNID)).toBe(true);

    // status check
    const check = (await api(sid, "POST", "/api/whatsapp/check")).json() as { connection: { health: { phone: { quality: string }; templates: { approved: number } } } };
    expect(check.connection.health.phone.quality).toBe("GREEN");
    expect(check.connection.health.templates.approved).toBe(1);
  });

  it("a number kept on the WhatsApp Business app (coexistence) is not re-registered", async () => {
    phones[0]!.is_on_biz_app = true;
    const sid = await sidFor(DOC);
    expect((await connect(sid, { coexistence: true })).statusCode).toBe(200);
    expect(calls.some((c) => c.path.endsWith("/register"))).toBe(false);
  });

  it("refuses a bad code, a number outside the account, a demo clinic and staff who aren't the doctor", async () => {
    const sid = await sidFor(DOC);
    exchangeOk = false;
    expect((await connect(sid)).json()).toMatchObject({ error: { code: "code_exchange_failed" } });
    exchangeOk = true;
    phones = [{ id: "999", display_phone_number: "+91 1", verified_name: "x" }];
    expect((await connect(sid)).json()).toMatchObject({ error: { code: "number_not_found" } });
    expect(await h.db.waConnection.count()).toBe(0);
    const demoDoc = (await h.app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { role: "DOCTOR" } })).cookies.find((c) => c.name === "sid")!.value;
    expect((await connect(demoDoc)).json()).toMatchObject({ error: { code: "not_customer_clinic" } });
    const demoStaff = (await h.app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { role: "STAFF" } })).cookies.find((c) => c.name === "sid")!.value;
    expect((await connect(demoStaff)).statusCode).toBe(403);
  });

  it("disconnect: unsubscribes, forgets the token at once, and stops answering on that number", async () => {
    const sid = await sidFor(DOC);
    await connect(sid);
    const r = await api(sid, "POST", "/api/whatsapp/disconnect");
    expect(r.json()).toMatchObject({ connection: null });
    expect(calls.some((c) => c.path === `${WABA}/subscribed_apps` && c.method === "DELETE")).toBe(true);
    const conn = await h.db.waConnection.findFirstOrThrow();
    expect(conn).toMatchObject({ status: "DISCONNECTED", token: "", pin: null });
    const payload = JSON.stringify(buildWebhook({ from: "919812300009", wamid: `wamid.t.${randomUUID()}`, message: { type: "text", text: { body: "Hi" } }, phoneNumberId: PNID }));
    await h.app.inject({ method: "POST", url: "/webhook", headers: { "content-type": "application/json", "x-hub-signature-256": signBody(payload, h.ctx.env.META_APP_SECRET) }, payload });
    expect(h.wa.sent.filter((s) => s.to === "919812300009")).toHaveLength(0);
  });
});

describe("customer clinics (Incolo admins)", () => {
  it("create one with the doctor's number; listed with its WhatsApp status; the doctor can then sign in to it", async () => {
    const admin = (await h.app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { role: "DOCTOR" } })).cookies.find((c) => c.name === "sid")!.value;
    const r = await api(admin, "POST", "/api/admin/clinics", { clinicName: "Care Plus Clinic", doctorName: "Dr. Rao", doctorPhone: "98450 12345", addressShort: "Indiranagar, Bengaluru", clinicPhone: "+91 80 4000 1111" });
    expect(r.statusCode).toBe(200);
    expect((await api(admin, "POST", "/api/admin/clinics", { clinicName: "Dup", doctorName: "Dr. X", doctorPhone: "98450 12345", addressShort: "x y", clinicPhone: "1234567" })).json()).toMatchObject({ error: { code: "phone_in_use" } });
    const list = (await api(admin, "GET", "/api/admin/clinics")).json() as { name: string; whatsapp: unknown }[];
    expect(list.map((c) => c.name)).toEqual(expect.arrayContaining(["Care Plus Clinic", "Sunrise Child Clinic"]));
    const rao = await sidFor("919845012345");
    expect((await api(rao, "GET", "/api/clinic")).json()).toMatchObject({ name: "Care Plus Clinic", ownNumber: true });
    expect((await api(rao, "GET", "/api/settings/sessions")).json()).toHaveLength(12);
    const staff = (await h.app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { role: "STAFF" } })).cookies.find((c) => c.name === "sid")!.value;
    expect((await api(staff, "GET", "/api/admin/clinics")).statusCode).toBe(403);
  });
});
