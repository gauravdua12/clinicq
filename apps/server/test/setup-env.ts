import { existsSync } from "node:fs";

// Secrets/DB settings come from .env; everything behavioural is forced offline below.
for (const f of [".env", "../../.env"]) if (existsSync(f)) { process.loadEnvFile(f); break; }
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://clinicq@localhost:5432/clinicq_test";
process.env.WA_MODE = "mock";
process.env.EXTRACTOR_PRIMARY = "rules";
process.env.EXTRACTOR_ESCALATION = "";
process.env.STT_PROVIDER = "mock";
process.env.DEV_TOOLS = "true";
process.env.WA_FLOW_ID_BOOKING = "";
process.env.FLOW_PRIVATE_KEY_PATH = "";
process.env.DEMO_STUDIO = "false";
process.env.DEMO_PRESENTER_PHONES = "";
process.env.BASE_PATH = "";
process.env.WA_DISPLAY_NUMBER = "919999900000";
