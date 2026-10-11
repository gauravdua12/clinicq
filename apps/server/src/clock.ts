// Injectable clock so scenario tests can control time (/dev/clock in dev).
export interface Clock { now(): Date }

export class SystemClock implements Clock {
  now(): Date { return new Date(); }
}

export class FakeClock implements Clock {
  private t: number;
  constructor(start: Date | string) { this.t = new Date(start).getTime(); }
  now(): Date { return new Date(this.t); }
  set(d: Date | string): void { this.t = new Date(d).getTime(); }
  advance(ms: number): void { this.t += ms; }
  advanceMinutes(m: number): void { this.t += m * 60_000; }
}

/** Real clock offset by a dev-set delta (dev simulator time travel). */
export class OffsetClock implements Clock {
  offsetMs = 0;
  now(): Date { return new Date(Date.now() + this.offsetMs); }
}
