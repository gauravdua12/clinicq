import { existsSync } from "node:fs";
import { createDb, initCrypto } from "../../../packages/db/src/index";
import { seed, truncateAll } from "../../../packages/db/src/seed";

export default async function globalSetup() {
  for (const f of [".env"]) if (existsSync(f)) process.loadEnvFile(f);
  initCrypto({ dataKeyB64: process.env.DATA_KEY!, pepperB64: process.env.HASH_PEPPER! });
  const db = createDb("postgresql://clinicq@localhost:5432/clinicq_ui");
  await truncateAll(db);
  await seed(db, { displayKey: "ui-key" });
  await db.$disconnect();
}
