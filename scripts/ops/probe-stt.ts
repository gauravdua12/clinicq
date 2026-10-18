/**
 * Check which speech-to-text services work on this AWS account (docs/AI_EXTRACTION.md §6), with local voice notes:
 *   npx tsx scripts/ops/probe-stt.ts note1.ogg note2.ogg …
 * Audio stays in memory; the transcripts are only printed here.
 */
import { readFileSync } from "node:fs";
import { amazonTranscribe, sttUnavailable, voxtral, type SpeechToText } from "../../packages/ai/src/stt";

const region = process.env.AWS_REGION ?? "ap-south-1";
const services: SpeechToText[] = [
  voxtral("mistral.voxtral-small-24b-2507", region),
  voxtral("mistral.voxtral-mini-3b-2507", region),
  amazonTranscribe(region),
];
for (const f of process.argv.slice(2)) {
  const audio = readFileSync(f);
  console.log(`\n== ${f.split("/").pop()}`);
  for (const s of services) {
    const t0 = Date.now();
    try {
      const r = await s.transcribe(audio, "audio/ogg; codecs=opus", 20_000);
      console.log(`  ${s.name}: OK ${Date.now() - t0} ms «${r.text}»${r.lang ? ` (${r.lang})` : ""}`);
    } catch (e) {
      const x = e as { name?: string; message?: string };
      console.log(`  ${s.name}: ${sttUnavailable(e) ? "UNAVAILABLE" : "FAILED"} ${Date.now() - t0} ms ${x.name}: ${String(x.message).slice(0, 160)}`);
    }
  }
}
