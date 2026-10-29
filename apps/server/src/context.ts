import type { Db } from "@clinicq/db";
import type { Logger } from "@clinicq/core";
import type { WhatsAppClient } from "@clinicq/wa";
import type { Clock } from "./clock";
import type { Env } from "./env";
import type { Scheduler } from "./jobs/scheduler";
import type { EventBus } from "./sse";
import type { SpeechToText } from "@clinicq/ai/stt";
import type { CascadeConfig } from "@clinicq/core/extract/index";
import type { KeyObject } from "node:crypto";

export interface Ctx {
  env: Env;
  db: Db;
  /** WhatsApp for the current clinic scope (services/whatsapp.ts). */
  wa: WhatsAppClient & { invalidate(clinicId?: string): void };
  /** The shared demo number's client (the mock in dev and tests). */
  sharedWa: WhatsAppClient;
  log: Logger;
  clock: Clock;
  bus: EventBus;
  jobs: Scheduler;
  tz: string;
  /** Resolves the current (admin-configurable) extraction cascade. */
  cascade(): Promise<CascadeConfig>;
  /** Resolves the current speech-to-text chain. */
  stt(): Promise<SpeechToText[]>;
  flowKey: KeyObject | null;
}
