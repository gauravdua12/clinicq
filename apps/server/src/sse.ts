import { EventEmitter } from "node:events";
import { currentScope } from "./scope";

// In-process event bus feeding Server-Sent Events to dashboards and the TV display.
export type BusEvent =
  | { type: "queue.updated"; doctorId: string }
  | { type: "appointment.changed"; id: string; status: string }
  | { type: "overflow.requested"; id: string; name: string; sessionLabel: string; expiresAt: string }
  | { type: "overflow.resolved"; id: string; status: string; by?: string }
  | { type: "doctor.status"; delayMin: number; pauseUntil: string | null }
  | { type: "callback.requested"; name: string; maskedPhone: string }
  | { type: "system.alert"; kind: string; message: string }
  | { type: "payment.claimed"; id: string; name: string; amount: string };

/** Events stay within their clinic (src/scope.ts): a dashboard or TV only hears its own clinic's events. */
export class EventBus extends EventEmitter {
  publish(e: BusEvent): void { this.emit("event", e, currentScope().clinicId); }
  subscribe(fn: (e: BusEvent) => void): () => void {
    const mine = currentScope().clinicId;
    const h = (e: BusEvent, clinicId: string | null) => { if (clinicId === mine) fn(e); };
    this.on("event", h);
    return () => this.off("event", h);
  }
}
