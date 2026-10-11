import { StartStreamTranscriptionCommand, TranscribeStreamingClient, type LanguageCode } from "@aws-sdk/client-transcribe-streaming";
import { mantlePost } from "./providers";

// Speech-to-text for voice notes (docs/AI_EXTRACTION.md §6). Audio stays in memory; nothing is stored.

export interface Transcript { text: string; lang?: string; confidence?: number }

export interface SpeechToText {
  name: string;
  transcribe(audio: Buffer, mime: string, timeoutMs: number): Promise<Transcript>;
}

/** Amazon Transcribe streaming — accepts WhatsApp OGG/Opus directly; identifies en-IN vs hi-IN. */
export function amazonTranscribe(region: string): SpeechToText {
  const client = new TranscribeStreamingClient({ region, maxAttempts: 1 });
  return {
    name: "transcribe",
    async transcribe(audio, _mime, timeoutMs) {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      async function* chunks() {
        for (let i = 0; i < audio.length; i += 8192) yield { AudioEvent: { AudioChunk: audio.subarray(i, i + 8192) } };
      }
      try {
        const res = await client.send(new StartStreamTranscriptionCommand({
          IdentifyLanguage: true,
          LanguageOptions: "en-IN,hi-IN",
          MediaEncoding: "ogg-opus",
          MediaSampleRateHertz: 16000,
          AudioStream: chunks(),
        }), { abortSignal: ac.signal });
        const parts: string[] = [];
        const confs: number[] = [];
        let lang: string | undefined;
        for await (const ev of res.TranscriptResultStream ?? []) {
          for (const r of ev.TranscriptEvent?.Transcript?.Results ?? []) {
            if (r.IsPartial) continue;
            const alt = r.Alternatives?.[0];
            if (alt?.Transcript) parts.push(alt.Transcript);
            for (const it of alt?.Items ?? []) if (typeof it.Confidence === "number") confs.push(it.Confidence);
            lang = (r.LanguageCode as LanguageCode | undefined) ?? lang;
          }
        }
        return { text: parts.join(" ").trim(), lang, confidence: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : undefined };
      } finally {
        clearTimeout(t);
      }
    },
  };
}

/** Sarvam AI speech-to-text (India-hosted; strong on Hinglish). Verify endpoint/model at go-live. */
export function sarvam(apiKey: string, model = "saarika:v2.5"): SpeechToText {
  return {
    name: "sarvam",
    async transcribe(audio, mime, timeoutMs) {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(audio)], { type: mime || "audio/ogg" }), "voice.ogg");
      form.append("model", model);
      form.append("language_code", "unknown");
      const res = await fetch("https://api.sarvam.ai/speech-to-text", { method: "POST", headers: { "api-subscription-key": apiKey }, body: form, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw Object.assign(new Error("sarvam_http"), { status: res.status });
      const j = (await res.json()) as { transcript?: string; language_code?: string };
      return { text: (j.transcript ?? "").trim(), lang: j.language_code };
    },
  };
}

/** Self-hosted open-source Whisper / faster-whisper with an OpenAI-compatible /audio/transcriptions API. */
export function whisperCompatible(baseUrl: string, model = "whisper-1", apiKey?: string): SpeechToText {
  return {
    name: "openai-compat",
    async transcribe(audio, mime, timeoutMs) {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(audio)], { type: mime || "audio/ogg" }), "voice.ogg");
      form.append("model", model);
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/audio/transcriptions`, { method: "POST", headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, body: form, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw Object.assign(new Error("whisper_http"), { status: res.status });
      const j = (await res.json()) as { text?: string; language?: string };
      return { text: (j.text ?? "").trim(), lang: j.language };
    },
  };
}

// ── Voxtral (Mistral speech model on Bedrock Mantle, in-region Mumbai) ──

/** 16-bit PCM mono WAV from Float32 channels (downmix + naive resample to 16 kHz). In memory only. */
export function toWav16k(channels: Float32Array[], sampleRate: number): Buffer {
  const len = channels[0]?.length ?? 0;
  const ratio = sampleRate / 16000;
  const outLen = Math.floor(len / ratio);
  const pcm = Buffer.alloc(44 + outLen * 2);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.max(start + 1, Math.floor((i + 1) * ratio));
    let acc = 0;
    let n = 0;
    for (let j = start; j < end && j < len; j++) for (const ch of channels) { acc += ch[j] ?? 0; n++; }
    const v = Math.max(-1, Math.min(1, n ? acc / n : 0));
    pcm.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  pcm.write("RIFF", 0); pcm.writeUInt32LE(36 + outLen * 2, 4); pcm.write("WAVE", 8); pcm.write("fmt ", 12);
  pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22); pcm.writeUInt32LE(16000, 24);
  pcm.writeUInt32LE(32000, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write("data", 36); pcm.writeUInt32LE(outLen * 2, 40);
  return pcm;
}

async function oggToWav(audio: Buffer): Promise<Buffer> {
  const { OggOpusDecoder } = await import("ogg-opus-decoder");
  const dec = new OggOpusDecoder();
  await dec.ready;
  try {
    const out = await dec.decodeFile(new Uint8Array(audio));
    return toWav16k(out.channelData, out.sampleRate);
  } finally {
    dec.free();
  }
}

/** Voxtral speech understanding via Mantle chat completions with audio input; returns the verbatim transcript. */
export function voxtral(model: string, region: string): SpeechToText {
  return {
    name: `voxtral:${model}`,
    async transcribe(audio, mime, timeoutMs) {
      const wav = /ogg|opus/i.test(mime) ? await oggToWav(audio) : audio;
      const j = await mantlePost(region, "/v1/chat/completions", {
        model, temperature: 0, max_tokens: 300,
        messages: [{ role: "user", content: [
          { type: "input_audio", input_audio: { data: wav.toString("base64"), format: "wav" } },
          { type: "text", text: "Transcribe this audio exactly, in its original language and script (Hindi in Devanagari, Hinglish in Roman script). Output only the transcript." },
        ] }],
      }, timeoutMs) as { choices?: { message?: { content?: string } }[] };
      return { text: String(j.choices?.[0]?.message?.content ?? "").trim() };
    },
  };
}

/** Dev/test: the simulator registers the "spoken" text for a media id. */
export class MockSpeechToText implements SpeechToText {
  name = "mock";
  readonly transcripts = new Map<string, string>();
  async transcribe(audio: Buffer): Promise<Transcript> {
    return { text: audio.toString("utf8"), confidence: 0.95 };
  }
}

export function sttFromSpec(spec: string, opts: { awsRegion: string; sarvamKey?: string; whisperBaseUrl?: string; mock?: SpeechToText }): SpeechToText | null {
  switch (spec) {
    case "": case "none": return null;
    case "transcribe": return amazonTranscribe(opts.awsRegion);
    case "voxtral-small": return voxtral("mistral.voxtral-small-24b-2507", opts.awsRegion);
    case "voxtral-mini": return voxtral("mistral.voxtral-mini-3b-2507", opts.awsRegion);
    case "sarvam": return opts.sarvamKey ? sarvam(opts.sarvamKey) : null;
    case "openai-compat": return opts.whisperBaseUrl ? whisperCompatible(opts.whisperBaseUrl) : null;
    case "mock": return opts.mock ?? new MockSpeechToText();
    default: return null;
  }
}
