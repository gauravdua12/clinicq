import { constants, createCipheriv, createDecipheriv, createPrivateKey, privateDecrypt, publicEncrypt, randomBytes, type KeyObject } from "node:crypto";

// WhatsApp Flows data-endpoint encryption (docs/WHATSAPP_INTEGRATION.md §6.2):
// AES key wrapped with RSA-OAEP(SHA-256); payload AES-128-GCM; response encrypted with the inverted IV.

export interface EncryptedFlowRequest { encrypted_flow_data: string; encrypted_aes_key: string; initial_vector: string }
export interface DecryptedFlowRequest { payload: Record<string, unknown>; aesKey: Buffer; iv: Buffer }

export class FlowDecryptError extends Error {}

export function loadPrivateKey(pem: string, passphrase?: string): KeyObject {
  return createPrivateKey({ key: pem, format: "pem", passphrase: passphrase || undefined });
}

export function decryptFlowRequest(body: EncryptedFlowRequest, key: KeyObject): DecryptedFlowRequest {
  try {
    const aesKey = privateDecrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(body.encrypted_aes_key, "base64"));
    const iv = Buffer.from(body.initial_vector, "base64");
    const data = Buffer.from(body.encrypted_flow_data, "base64");
    const tag = data.subarray(-16);
    const ct = data.subarray(0, -16);
    const d = createDecipheriv(`aes-${aesKey.length * 8}-gcm` as "aes-128-gcm", aesKey, iv);
    d.setAuthTag(tag);
    const plain = Buffer.concat([d.update(ct), d.final()]).toString("utf8");
    return { payload: JSON.parse(plain), aesKey, iv };
  } catch {
    throw new FlowDecryptError("flow decrypt failed");
  }
}

export function encryptFlowResponse(response: unknown, aesKey: Buffer, iv: Buffer): string {
  const flipped = Buffer.from(iv.map((b) => ~b & 0xff));
  const c = createCipheriv(`aes-${aesKey.length * 8}-gcm` as "aes-128-gcm", aesKey, flipped);
  const ct = Buffer.concat([c.update(JSON.stringify(response), "utf8"), c.final(), c.getAuthTag()]);
  return ct.toString("base64");
}

/** Client side of the protocol (simulator + tests): encrypt a request and decrypt a response. */
export function encryptFlowRequestForTest(payload: unknown, publicKeyPem: string): { body: EncryptedFlowRequest; aesKey: Buffer; iv: Buffer } {
  const aesKey = randomBytes(16);
  const iv = randomBytes(16);
  const c = createCipheriv("aes-128-gcm", aesKey, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(payload), "utf8"), c.final(), c.getAuthTag()]);
  const wrapped = publicEncrypt({ key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, aesKey);
  return { body: { encrypted_flow_data: ct.toString("base64"), encrypted_aes_key: wrapped.toString("base64"), initial_vector: iv.toString("base64") }, aesKey, iv };
}

export function decryptFlowResponseForTest(b64: string, aesKey: Buffer, iv: Buffer): unknown {
  const flipped = Buffer.from(iv.map((b) => ~b & 0xff));
  const data = Buffer.from(b64, "base64");
  const d = createDecipheriv("aes-128-gcm", aesKey, flipped);
  d.setAuthTag(data.subarray(-16));
  return JSON.parse(Buffer.concat([d.update(data.subarray(0, -16)), d.final()]).toString("utf8"));
}
