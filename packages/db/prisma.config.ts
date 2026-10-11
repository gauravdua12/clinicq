import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";

for (const f of ["../../.env", ".env"]) if (existsSync(f)) process.loadEnvFile(f);

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env["DATABASE_URL"] ?? "postgresql://clinicq@localhost:5432/clinicq" },
});
