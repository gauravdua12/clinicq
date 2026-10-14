import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createDb, encrypt, initCrypto, phoneHash, type Db } from "./index";

// Demo clinic matching docs/TESTING.md §2 and the QUEUE_ENGINE worked examples.

export const SEED = {
  doctorPhone: "919999900001",
  staffPhone: "919999900002",
  clinicCode: "DRS",
};

/** Default slot length is 15 minutes (doctors change it in Settings → Sessions). Test fixtures pin 20 to keep their timings. */
export async function seed(db: Db, opts: { displayKey?: string; slotMinutes?: number } = {}): Promise<{ clinicId: string; doctorId: string }> {
  const slotMinutes = opts.slotMinutes ?? 15;
  const clinic = await db.clinic.create({
    data: {
      name: "Dr. Sharma's Clinic", addressShort: "Sector 15, Gurugram", addressFull: "SCO 21, Sector 15 Market, Gurugram, Haryana 122001",
      mapsUrl: "https://maps.app.goo.gl/example", phone: "+91 11 4000 1234", code: SEED.clinicCode, noticeUrl: "http://localhost:8080/privacy",
      grievanceContact: { name: "Grievance Officer, Incolo Systems (ClinicQ)", email: "customercare@incolosystems.com", phone: "+91 11 4000 1234" },
      settings: { fees: "₹600 (follow-up within 7 days ₹300)" },
      displayKey: opts.displayKey ?? randomBytes(18).toString("base64url"),
    },
  });
  const doctor = await db.doctor.create({ data: { clinicId: clinic.id, displayName: "Dr. Sharma", qualification: "MBBS, MD (Medicine)" } });
  for (let wd = 1; wd <= 6; wd++) {
    await db.session.create({ data: { doctorId: doctor.id, weekday: wd, label: "Morning", startTime: "10:00", endTime: "13:00", slotMinutes, walkinQuota: 10 } });
    await db.session.create({ data: { doctorId: doctor.id, weekday: wd, label: "Evening", startTime: "17:10", endTime: "20:00", slotMinutes, walkinQuota: 10 } });
  }
  await db.staffUser.create({ data: { clinicId: clinic.id, name: "Dr. Sharma", waPhone: encrypt(SEED.doctorPhone), phoneHash: phoneHash(SEED.doctorPhone), role: "DOCTOR" } });
  await db.staffUser.create({ data: { clinicId: clinic.id, name: "Priya", waPhone: encrypt(SEED.staffPhone), phoneHash: phoneHash(SEED.staffPhone), role: "STAFF" } });
  return { clinicId: clinic.id, doctorId: doctor.id };
}

export async function truncateAll(db: Db): Promise<void> {
  const tables = await db.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length) await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const f of [".env", "../../.env"]) if (existsSync(f)) { process.loadEnvFile(f); break; }
  initCrypto({ dataKeyB64: process.env.DATA_KEY!, pepperB64: process.env.HASH_PEPPER! });
  const db = createDb(process.env.DATABASE_URL!);
  // Fail-safe: seeding wipes every table. In production it runs only on an empty database (first install).
  if (process.env.NODE_ENV === "production" && (await db.clinic.count()) > 0) {
    console.error("Refusing to seed: this production database already has data (seeding would erase it).");
    await db.$disconnect();
    process.exit(1);
  }
  await truncateAll(db);
  const displayKey = process.env.SEED_DISPLAY_KEY || "dev";
  const r = await seed(db, { displayKey });
  console.log("Seeded demo clinic", r, displayKey === "dev" ? "display key: dev" : "display key set");
  await db.$disconnect();
}
