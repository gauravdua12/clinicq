import { EventEmitter } from "node:events";

// In-process event bus feeding Server-Sent Events to dashboards and the TV display.
export type BusEvent =
  | { type: "queue.updated"; doctorId: string }
  | { type: "appointment.changed"; id: string; status: string }
  | { type: "overflow.requested"; id: string; name: string; sessionLabel: string; expiresAt: string }
  | { type: "overflow.resolved"; id: string; status: string; by?: string }
  | { type: "doctor.status"; delayMin: number; pauseUntil: string | null }
  | { type: "callback.requested"; name: string; maskedPhone: string }
  | { type: "system.alert"; kind: string; message: string };

export class EventBus extends EventEmitter {
  publish(e: BusEvent): void { this.emit("event", e); }
  subscribe(fn: (e: BusEvent) => void): () => void {
    this.on("event", fn);
    return () => this.off("event", fn);
  }
}
