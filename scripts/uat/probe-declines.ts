/**
 * Probe: how the conversation answers declines / closings / off-workflow messages with the LIVE models.
 *   npx tsx scripts/uat/probe-declines.ts
 */
import { existsSync } from "node:fs";
if (existsSync(".env")) process.loadEnvFile(".env");
Object.assign(process.env, { DATABASE_URL: "postgresql://clinicq@localhost:5432/clinicq_test", WA_MODE: "mock", DEV_TOOLS: "true", BASE_PATH: "", DEMO_STUDIO: "false", DEMO_PRESENTER_PHONES: "" });
const { harness, onboard } = await import("../../apps/server/test/harness");
const { modelFromSpec } = await import("../../packages/ai/src/providers");
const { previewText } = await import("../../packages/wa/src/messages");

export const DECLINES = [
  "I don't want to book", "I dont want any appointment", "no booking needed", "no thanks", "no", "nothing", "not now",
  "never mind", "I changed my mind", "bye", "ok bye", "thank you, that's all", "close this chat", "end the chat", "stop the booking",
  "leave it", "forget it", "wrong number", "sorry, messaged by mistake", "I'll call the clinic instead", "just checking", "testing",
  "mujhe appointment nahi chahiye", "nahi chahiye", "kuch nahi", "rehne do", "bas", "abhi nahi", "booking mat karo", "मुझे अपॉइंटमेंट नहीं चाहिए",
];
const o = { awsRegion: "ap-south-1" };
const h = await harness({ start: "2026-10-09T12:00:00+05:30" });
h.ctx.cascade = async () => ({ primary: modelFromSpec("bedrock-mantle:qwen.qwen3-32b", o), escalation: modelFromSpec("bedrock-mantle:mistral.mistral-large-3-675b-instruct", o), minConfidence: 0.7, timeoutMs: 6000 });
let n = 0;
const P = () => `9197${String(++n).padStart(8, "0")}`;
const SETUPS: [string, (p: string) => Promise<void>][] = [
  ["menu", async (p) => { await onboard(h, p); }],
  ["mid-booking", async (p) => { await onboard(h, p); await h.say(p, "book tomorrow evening for me"); await h.tap(p, "who:me"); }],
];
for (const [label, setup] of SETUPS) {
  console.log(`\n### after ${label}`);
  for (const text of DECLINES) {
    const p = P(); await setup(p);
    const before = h.wa.to(p).length;
    await h.say(p, text);
    const out = h.wa.to(p).slice(before);
    const kinds = (await h.kinds(p)).slice(-out.length);
    const btns = out.flatMap((m) => (m.kind === "buttons" ? m.buttons.map((b) => b.title) : []));
    console.log(`${text.padEnd(34)} → ${kinds.join("+")}${btns.length ? `  [${btns.join(" | ")}]` : ""}  «${out.map((m) => previewText(m)).join(" / ").slice(0, 110)}»`);
  }
}
await h.close();
process.exit(0);
