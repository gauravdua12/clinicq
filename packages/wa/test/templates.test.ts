import { describe, expect, it } from "vitest";
import { TEMPLATES, TEMPLATE_TEXT } from "../src";

// Meta rejects templates whose variables are out of sequence or whose examples don't match.
describe("template texts submitted to Meta", () => {
  for (const [name, def] of Object.entries(TEMPLATES)) {
    if (name === "staff_login_otp") continue;
    for (const lang of ["en", "hi"] as const) {
      it(`${name}/${lang}`, () => {
        const t = TEMPLATE_TEXT[name as keyof typeof TEMPLATE_TEXT][lang];
        const vars = [...t.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
        expect(vars, "variables appear in order 1..n").toEqual(def.params.map((_, i) => i + 1));
        expect(t.examples).toHaveLength(def.params.length);
        expect(t.body.length).toBeLessThan(1024);
        const qrs = (t.buttons ?? []).filter((b) => b.type === "QUICK_REPLY");
        expect(qrs.length, "one quick reply per payload").toBe(((def as { quickReplies?: string[] }).quickReplies ?? []).length);
        for (const b of t.buttons ?? []) expect([...b.text].length).toBeLessThanOrEqual(25);
        expect(t.body.trim(), "Meta rejects a body that starts or ends with a variable").not.toMatch(/^\{\{\d+\}\}|\{\{\d+\}\}[.।]?$/);
      });
    }
  }
});
