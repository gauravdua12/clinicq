import { z } from "zod";

// Clinic.settings (docs/SCHEMA.md "ClinicSettings"). Defaults fill anything missing.
export const ClinicSettings = z.object({
  windowDays: z.number().int().min(1).max(60).default(7),
  cutoffMinutes: z.number().int().min(0).default(60),
  lateGraceMinutes: z.number().int().min(0).default(15),
  noShowGraceMinutes: z.number().int().min(0).default(30),
  nearWindowMinutes: z.number().int().min(10).default(60),
  holdMinutes: z.number().int().min(1).default(5),
  maxActiveBookingsPerProfile: z.number().int().min(1).default(2),
  earlyArrivalMinutes: z.number().int().min(0).default(60),
  earlyCheckInMinutes: z.number().int().min(0).default(30),
  walkinOverflowTimeoutMinutes: z.number().int().min(1).default(5),
  turnNearThreshold: z.number().int().min(0).default(2),
  maxConsecutiveWalkins: z.number().int().min(1).default(2),
  tokenSeries: z.object({
    singleSeries: z.boolean().default(false),
    appointmentPrefix: z.string().default("A"),
    walkinPrefix: z.string().default("W"),
    appointmentTokenMode: z.enum(["slotIndex", "sequential"]).default("slotIndex"),
  }).default({ singleSeries: false, appointmentPrefix: "A", walkinPrefix: "W", appointmentTokenMode: "slotIndex" }),
  display: z.object({ showFirstName: z.boolean().default(true), voiceCallout: z.boolean().default(true), showQr: z.boolean().default(true) })
    .default({ showFirstName: true, voiceCallout: true, showQr: true }),
  flowsEnabled: z.boolean().default(true),
  fees: z.string().default(""),
  payments: z.object({ enabled: z.boolean().default(false), amountPaise: z.number().default(0) }).default({ enabled: false, amountPaise: 0 }),
  retention: z.object({
    messageLogDays: z.number().default(90),
    visitAnonymiseDays: z.number().default(180),
    inactiveProfileMonths: z.number().default(12),
    auditDays: z.number().default(365),
  }).default({ messageLogDays: 90, visitAnonymiseDays: 180, inactiveProfileMonths: 12, auditDays: 365 }),
  emergencyKeywordsExtra: z.array(z.string()).default([]),
  noticeVersion: z.string().default("2026-10-v1"),
});
export type ClinicSettings = z.infer<typeof ClinicSettings>;

export function parseSettings(raw: unknown): ClinicSettings {
  return ClinicSettings.parse(raw ?? {});
}

// Admin-only language-model configuration (SystemConfig key "ai").
export const AiConfig = z.object({
  primary: z.string().default("rules"),
  escalation: z.string().default(""),
  minConfidence: z.number().min(0).max(1).default(0.7),
  timeoutMs: z.number().int().min(500).max(20000).default(3500),
  stt: z.string().default("mock"),
  sttFallback: z.string().default(""),
});
export type AiConfig = z.infer<typeof AiConfig>;
