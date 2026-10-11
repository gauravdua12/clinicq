// Generate the RSA key pair for the WhatsApp Flow endpoint (docs/WHATSAPP_INTEGRATION.md §1 step 11).
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
const dir = process.argv[2] ?? ".flow-dev-keys";
mkdirSync(dir, { recursive: true });
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
writeFileSync(`${dir}/private.pem`, privateKey, { mode: 0o600 });
writeFileSync(`${dir}/public.pem`, publicKey);
console.log(`Wrote ${dir}/private.pem (keep secret) and ${dir}/public.pem (upload to Meta: POST /{phone-number-id}/whatsapp_business_encryption).`);
