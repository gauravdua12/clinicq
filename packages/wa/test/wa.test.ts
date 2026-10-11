import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildWebhook, decryptFlowRequest, decryptFlowResponseForTest, encryptFlowRequestForTest, encryptFlowResponse,
  loadPrivateKey, parseWebhook, signBody, toCloudPayload, validate, verifySignature, MessageLimitError,
} from "../src";

describe("webhook signature", () => {
  it("accepts a correct signature and rejects tampering", () => {
    const body = Buffer.from(JSON.stringify({ a: 1 }));
    const sig = signBody(body, "secret");
    expect(verifySignature(body, sig, "secret")).toBe(true);
    expect(verifySignature(Buffer.from('{"a":2}'), sig, "secret")).toBe(false);
    expect(verifySignature(body, undefined, "secret")).toBe(false);
  });
});

describe("parseWebhook", () => {
  it("normalises text, buttons, flows, voice and media", () => {
    const mk = (message: Record<string, unknown>) => parseWebhook(buildWebhook({ from: "919876543210", name: "Ramesh", wamid: "w1", message })).messages[0]!;
    expect(mk({ type: "text", text: { body: "hi" } })).toMatchObject({ kind: "text", text: "hi", profileName: "Ramesh", from: "919876543210" });
    expect(mk({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: "slot:x", title: "6:10 PM" } } })).toMatchObject({ kind: "button", buttonId: "slot:x" });
    expect(mk({ type: "interactive", interactive: { type: "nfm_reply", nfm_reply: { response_json: '{"slot":"x"}' } } })).toMatchObject({ kind: "flow", flowResponse: { slot: "x" } });
    expect(mk({ type: "audio", audio: { id: "m1", voice: true } })).toMatchObject({ kind: "audio", mediaId: "m1", isVoice: true });
    expect(mk({ type: "image", image: { id: "m2" } })).toMatchObject({ kind: "media", mediaType: "image" });
    expect(mk({ type: "image", image: { id: "m2" } }).mediaId).toBeUndefined();
    expect(mk({ type: "button", button: { payload: "appt:ok", text: "Confirm" } })).toMatchObject({ kind: "button", buttonId: "appt:ok" });
  });
  it("ignores garbage", () => expect(parseWebhook({ nope: true }).messages).toEqual([]));
});

describe("message limits", () => {
  it("rejects >3 buttons, >20-char titles, >10 list rows", () => {
    expect(() => validate({ kind: "buttons", body: "x", buttons: [1, 2, 3, 4].map((i) => ({ id: `b${i}`, title: "t" })) })).toThrow(MessageLimitError);
    expect(() => validate({ kind: "buttons", body: "x", buttons: [{ id: "a", title: "x".repeat(21) }] })).toThrow(MessageLimitError);
    expect(() => validate({ kind: "list", body: "x", button: "View", sections: [{ title: "s", rows: Array.from({ length: 11 }, (_, i) => ({ id: `r${i}`, title: "t" })) }] })).toThrow(MessageLimitError);
  });
  it("builds Graph payloads", () => {
    const p = toCloudPayload("9199", { kind: "buttons", body: "Pick", buttons: [{ id: "a", title: "5:50 PM" }] }) as { interactive: { action: { buttons: { reply: { id: string } }[] } } };
    expect(p.interactive.action.buttons[0]!.reply.id).toBe("a");
  });
});

describe("flow crypto", () => {
  it("round-trips request and inverted-IV response", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    const { body, aesKey, iv } = encryptFlowRequestForTest({ action: "ping", version: "3.0" }, publicKey);
    const dec = decryptFlowRequest(body, loadPrivateKey(privateKey));
    expect(dec.payload).toEqual({ action: "ping", version: "3.0" });
    const resp = encryptFlowResponse({ data: { status: "active" } }, dec.aesKey, dec.iv);
    expect(decryptFlowResponseForTest(resp, aesKey, iv)).toEqual({ data: { status: "active" } });
  });
});

describe("authentication template payload", () => {
  it("adds the copy-code button parameter only when otpCode is set", async () => {
    const { toCloudPayload } = await import("../src/messages");
    const p = toCloudPayload("919900000000", { kind: "template", name: "staff_login_otp", lang: "en", bodyParams: ["123456"], otpCode: "123456" }) as { template: { components: { type: string; sub_type?: string; parameters: { text?: string }[] }[] } };
    expect(p.template.components).toContainEqual({ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "123456" }] });
    const q = toCloudPayload("919900000000", { kind: "template", name: "reminder_24h", lang: "en", bodyParams: ["a"] }) as typeof p;
    expect(q.template.components.some((c) => c.sub_type === "url")).toBe(false);
  });
});
