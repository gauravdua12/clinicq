import { AsyncLocalStorage } from "node:async_hooks";

// Which clinic the current work belongs to (docs/ARCHITECTURE.md "Clinics on their own numbers").
//
// - clinicId set: a customer clinic on its own WhatsApp number. Its patients, staff, jobs, TV display and pages.
// - clinicId null: the shared demo number, serving whichever clinic is active (Demo Studio), as before.
//
// Set once where work enters the server (webhook message, dashboard request, job, public page); everything below
// (clinicInfo, sending WhatsApp, events, jobs scheduled from here) follows it without passing it around.

export interface Scope { clinicId: string | null }

export const DEMO_CHANNEL = "demo";

const als = new AsyncLocalStorage<Scope>();

export function currentScope(): Scope {
  return als.getStore() ?? { clinicId: null };
}

/** The patient-account channel for the current scope: the customer clinic's id, or the shared demo number. */
export function currentChannel(): string {
  return currentScope().clinicId ?? DEMO_CHANNEL;
}

export function inScope<T>(scope: Scope, fn: () => T): T {
  return als.run(scope, fn);
}

/** Scope of a patient-account channel (the reverse of currentChannel). */
export function scopeOfChannel(channel: string): Scope {
  return { clinicId: channel === DEMO_CHANNEL ? null : channel };
}
