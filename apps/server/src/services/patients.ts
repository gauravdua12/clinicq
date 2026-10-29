import { decrypt, encrypt, phoneHash, type PatientAccount, type PatientProfile } from "@clinicq/db";
import type { extract as X } from "@clinicq/core";
import type { Ctx } from "../context";
import { currentChannel } from "../scope";

// Patient identity: account = WhatsApp number (per clinic number, src/scope.ts); profiles = family members. Logistics only.

export async function findOrCreateAccount(ctx: Ctx, waId: string, profileName?: string): Promise<PatientAccount> {
  const hash = phoneHash(waId);
  const now = ctx.clock.now();
  const channel = currentChannel();
  const existing = await ctx.db.patientAccount.findUnique({ where: { channel_phoneHash: { channel, phoneHash: hash } } });
  if (existing) {
    return ctx.db.patientAccount.update({
      where: { id: existing.id },
      data: { lastInboundAt: now, lastActivityAt: now, ...(profileName && !existing.waProfileName ? { waProfileName: encrypt(profileName) } : {}) },
    });
  }
  return ctx.db.patientAccount.create({
    data: { channel, waPhone: encrypt(waId), phoneHash: hash, waProfileName: profileName ? encrypt(profileName) : null, lastInboundAt: now, lastActivityAt: now },
  });
}

export function waName(acc: PatientAccount): string | null {
  if (!acc.waProfileName) return null;
  const n = decrypt(acc.waProfileName).replace(/[^\p{L}\p{M} .'-]/gu, "").trim();
  return n ? n.split(/\s+/)[0]! : null;
}

export async function hasConsent(ctx: Ctx, accountId: string): Promise<boolean> {
  return !!(await ctx.db.consentRecord.findFirst({ where: { accountId, withdrawnAt: null } }));
}

export async function recordConsent(ctx: Ctx, accountId: string, noticeVersion: string, language: "en" | "hi" | "hinglish"): Promise<void> {
  await ctx.db.consentRecord.create({ data: { accountId, noticeVersion, language } });
}

export interface ProfileView { id: string; name: string; relation: PatientProfile["relation"]; ref: string; contactPhone: string | null }

export async function profilesOf(ctx: Ctx, accountId: string): Promise<ProfileView[]> {
  const ps = await ctx.db.patientProfile.findMany({ where: { accountId }, orderBy: { createdAt: "asc" } });
  return ps.map((p, i) => ({ id: p.id, name: decrypt(p.name), relation: p.relation, ref: `P${i + 1}`, contactPhone: p.contactPhone ? decrypt(p.contactPhone) : null }));
}

export function profileLabels(ps: ProfileView[]): X.ProfileLabel[] {
  return ps.map((p) => ({ ref: p.ref, relation: p.relation }));
}

export function firstName(n: string): string {
  return n.trim().split(/\s+/)[0] ?? n;
}

export async function createProfile(ctx: Ctx, accountId: string, name: string, relation: PatientProfile["relation"]): Promise<ProfileView> {
  const p = await ctx.db.patientProfile.create({ data: { accountId, name: encrypt(name), relation } });
  const all = await profilesOf(ctx, accountId);
  return all.find((x) => x.id === p.id)!;
}

/** Match a typed name against this account's profiles (first-name, case-insensitive). Names never leave the server. */
export function matchProfileByName(ps: ProfileView[], name: string | null | undefined): ProfileView | undefined {
  if (!name) return undefined;
  const want = name.trim().toLowerCase();
  const wantFirst = want.split(/\s+/)[0];
  return ps.find((p) => p.name.toLowerCase() === want) ?? ps.find((p) => firstName(p.name).toLowerCase() === wantFirst);
}

export const RELATION_LABEL: Record<string, { en: string; hi: string; hinglish: string }> = {
  MOTHER: { en: "Mother", hi: "माँ", hinglish: "Mummy" },
  FATHER: { en: "Father", hi: "पिताजी", hinglish: "Papa" },
  SPOUSE: { en: "Spouse", hi: "पति/पत्नी", hinglish: "Spouse" },
  SON: { en: "Son", hi: "बेटा", hinglish: "Beta" },
  DAUGHTER: { en: "Daughter", hi: "बेटी", hinglish: "Beti" },
  SIBLING: { en: "Sibling", hi: "भाई/बहन", hinglish: "Bhai/Behen" },
  GRANDPARENT: { en: "Grandparent", hi: "दादा/दादी", hinglish: "Dada/Dadi" },
  OTHER: { en: "Family", hi: "परिवार", hinglish: "Family" },
};
