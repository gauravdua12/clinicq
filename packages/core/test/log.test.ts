import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/log";

describe("redacting logger", () => {
  it("never writes message text, names or phone numbers", () => {
    let out = "";
    const dest = new Writable({ write(c, _e, cb) { out += c.toString(); cb(); } });
    const log = createLogger({ destination: dest as never });
    log.info({ text: "bukhar hai", name: "Ramesh", nested: { caption: "x", note: "call 9876543210" } }, "inbound from 919876543210");
    expect(out).not.toMatch(/bukhar|Ramesh|9876543210/);
    expect(out).toContain("[redacted]");
  });
});
