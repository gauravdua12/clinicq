import { describe, expect, it, vi } from "vitest";
import { createLogger } from "@clinicq/core";
import { Scheduler } from "../../src/jobs/scheduler";
import { SystemClock } from "../../src/clock";

// Regression: a database outage made the poll loop reject unhandled and crashed the process.
describe("scheduler resilience", () => {
  it("survives a failing database and recovers when it returns", async () => {
    let down = true;
    const db = { $queryRaw: vi.fn(async () => { if (down) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); return []; }) };
    const s = new Scheduler(db as never, new SystemClock(), createLogger({ level: "silent" }));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      s.start(20);
      await new Promise((r) => setTimeout(r, 120));
      expect(db.$queryRaw.mock.calls.length).toBeGreaterThan(2); // kept retrying
      down = false;
      await expect(s.runDue()).resolves.toBe(0); // not stuck in "running"
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      s.stop();
      process.off("unhandledRejection", unhandled);
    }
  });
});
