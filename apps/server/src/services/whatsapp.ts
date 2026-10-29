import { decrypt, type Db } from "@clinicq/db";
import { CloudApiClient, MockWhatsApp, WhatsAppApiError, type OutMsg, type SendResult, type WhatsAppClient } from "@clinicq/wa";
import { currentScope, type Scope } from "../scope";

// WhatsApp per clinic: a customer clinic sends from its own connected number (its own token); everything else uses the
// shared demo number from the env. Chosen by the current scope (src/scope.ts), so callers just use ctx.wa.

export class NotConnectedError extends WhatsAppApiError {
  constructor() { super(409); this.message = "whatsapp_not_connected"; }
}

export class RoutedWhatsApp implements WhatsAppClient {
  private clients = new Map<string, { at: number; client: WhatsAppClient | null }>();

  constructor(private shared: WhatsAppClient, private db: Db, private graphVersion: string) {}

  /** Forget cached clients (after a clinic connects or disconnects its number). */
  invalidate(clinicId?: string): void {
    if (clinicId) this.clients.delete(clinicId); else this.clients.clear();
  }

  /** The client for a scope: the clinic's own number, or the shared number for the demo scope. */
  async forScope(scope: Scope): Promise<WhatsAppClient> {
    if (!scope.clinicId) return this.shared;
    const hit = this.clients.get(scope.clinicId);
    if (hit && Date.now() - hit.at < 60_000) { if (hit.client) return hit.client; throw new NotConnectedError(); }
    const conn = await this.db.waConnection.findUnique({ where: { clinicId: scope.clinicId } });
    let client: WhatsAppClient | null = null;
    if (conn?.status === "CONNECTED") {
      client = this.shared instanceof MockWhatsApp
        ? this.shared.as(conn.phoneNumberId)
        : new CloudApiClient({ token: decrypt(conn.token), phoneNumberId: conn.phoneNumberId, graphVersion: this.graphVersion });
    }
    this.clients.set(scope.clinicId, { at: Date.now(), client });
    if (!client) throw new NotConnectedError();
    return client;
  }

  async send(to: string, msg: OutMsg): Promise<SendResult> {
    return (await this.forScope(currentScope())).send(to, msg);
  }

  async downloadMedia(mediaId: string, maxBytes: number): Promise<{ data: Buffer; mime: string }> {
    return (await this.forScope(currentScope())).downloadMedia(mediaId, maxBytes);
  }

  async markRead(wamid: string): Promise<void> {
    return (await this.forScope(currentScope())).markRead(wamid);
  }
}

/** The WhatsApp number patients message (digits): the clinic's own connected number, else the shared demo number. */
export async function clinicWaNumber(ctx: { db: Db; env: { WA_DISPLAY_NUMBER?: string } }): Promise<string> {
  const { clinicId } = currentScope();
  if (clinicId) {
    const conn = await ctx.db.waConnection.findUnique({ where: { clinicId }, select: { displayPhone: true, status: true } });
    const digits = conn?.status === "CONNECTED" ? (conn.displayPhone ?? "").replace(/\D/g, "") : "";
    if (digits) return digits;
  }
  return ctx.env.WA_DISPLAY_NUMBER || "910000000000";
}
