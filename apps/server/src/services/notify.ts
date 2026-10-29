import { decrypt } from "@clinicq/db";
import { TEMPLATES, templateLang, type OutMsg, type TemplateDef, type TemplateName } from "@clinicq/wa";
import type { Ctx } from "../context";

// Window-aware sender (docs/WHATSAPP_INTEGRATION.md §3). Logs only copy IDs / template names.

const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface SendOpts {
  kind: string; // copy id or label, for MessageLog
  accountId?: string | null;
  /** Fallback template used when outside the 24h customer-service window. */
  template?: { name: TemplateName; vars: Record<string, string | number>; lang: "en" | "hi" | "hinglish" };
  /** Non-essential (reminders/alerts) are suppressed for opted-out patients. */
  essential?: boolean;
}

export async function sendTo(ctx: Ctx, waId: string, msg: OutMsg, o: SendOpts): Promise<boolean> {
  let out = msg;
  if (o.accountId) {
    const acc = await ctx.db.patientAccount.findUnique({ where: { id: o.accountId }, select: { lastInboundAt: true, optedOutAt: true } });
    if (acc?.optedOutAt && o.essential === false) {
      await logOut(ctx, o.accountId, `suppressed:${o.kind}`);
      return false;
    }
    const inWindow = !!acc?.lastInboundAt && ctx.clock.now().getTime() - acc.lastInboundAt.getTime() < WINDOW_MS;
    if (!inWindow) {
      if (!o.template) {
        await logOut(ctx, o.accountId, `skipped_outside_window:${o.kind}`);
        return false;
      }
      const def: TemplateDef = TEMPLATES[o.template.name];
      const vars = o.template.vars;
      const ref = vars.ref ?? vars.apptId; // e.g. "appt:cx:<id>", "fu:<id>"
      out = {
        kind: "template",
        name: def.name,
        lang: templateLang(o.template.lang),
        bodyParams: def.params.map((p) => String(vars[p] ?? "")),
        quickReplyPayloads: def.quickReplies?.map((q) => (ref ? `${q}:${ref}` : q)),
        urlButtonParam: def.urlParam ? String(vars[def.urlParam] ?? "") : undefined,
      };
    }
  }
  try {
    const r = await ctx.wa.send(waId, out);
    await ctx.db.messageLog.create({ data: { accountId: o.accountId ?? null, direction: "OUT", kind: out.kind === "template" ? `template:${out.name}` : o.kind, wamid: r.wamid || null, status: "sent" } });
    return true;
  } catch (e) {
    ctx.log.error({ err: e, kind: o.kind }, "send_failed");
    await logOut(ctx, o.accountId ?? null, `failed:${o.kind}`);
    return false;
  }
}

async function logOut(ctx: Ctx, accountId: string | null, kind: string) {
  await ctx.db.messageLog.create({ data: { accountId, direction: "OUT", kind, status: "not_sent" } });
}

/** Send to an account by id (jobs/alerts): decrypts the WhatsApp number in memory. */
export async function sendToAccount(ctx: Ctx, accountId: string, msg: OutMsg, o: Omit<SendOpts, "accountId">): Promise<boolean> {
  const acc = await ctx.db.patientAccount.findUnique({ where: { id: accountId }, select: { waPhone: true } });
  if (!acc) return false;
  return sendTo(ctx, decrypt(acc.waPhone), msg, { ...o, accountId });
}

export async function audit(ctx: Ctx, actorType: string, actorId: string | null, action: string, entity: string, entityId: string | null, diff?: Record<string, unknown>): Promise<void> {
  await ctx.db.auditLog.create({ data: { actorType, actorId, action, entity, entityId, diff: (diff ?? undefined) as never } });
}
