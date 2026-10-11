import { modelFromSpec } from "@clinicq/ai";
import { sttFromSpec, type SpeechToText } from "@clinicq/ai/stt";
import { smokeTest, type SmokeResult } from "@clinicq/ai/smoke";
import { MODEL_CATALOG, type CascadeConfig } from "@clinicq/core/extract/index";
import type { Db } from "@clinicq/db";
import type { Env } from "../env";
import { AiConfig } from "../settings";

// Admin-switchable language-model configuration (SystemConfig "ai"); env provides defaults.

export function envAiConfig(env: Env): AiConfig {
  return AiConfig.parse({ primary: env.EXTRACTOR_PRIMARY, escalation: env.EXTRACTOR_ESCALATION, minConfidence: env.EXTRACTOR_MIN_CONFIDENCE, timeoutMs: env.EXTRACTOR_TIMEOUT_MS, stt: env.STT_PROVIDER, sttFallback: env.STT_FALLBACK });
}

export class AiRuntime {
  private cached: { at: number; cfg: AiConfig } | null = null;
  constructor(private db: Db, private env: Env, private mockStt?: SpeechToText) {}

  async config(): Promise<AiConfig> {
    if (this.cached && Date.now() - this.cached.at < 30_000) return this.cached.cfg;
    const row = await this.db.systemConfig.findUnique({ where: { key: "ai" } });
    const cfg = row ? AiConfig.parse({ ...envAiConfig(this.env), ...(row.value as object) }) : envAiConfig(this.env);
    this.cached = { at: Date.now(), cfg };
    return cfg;
  }

  invalidate(): void { this.cached = null; }

  toCascade(cfg: AiConfig): CascadeConfig {
    const opts = { awsRegion: this.env.AWS_REGION, openaiCompatBaseUrl: this.env.OPENAI_COMPAT_BASE_URL, openaiCompatApiKey: this.env.OPENAI_COMPAT_API_KEY, anthropicApiKey: this.env.ANTHROPIC_API_KEY };
    return { primary: modelFromSpec(cfg.primary, opts), escalation: modelFromSpec(cfg.escalation, opts), minConfidence: cfg.minConfidence, timeoutMs: cfg.timeoutMs };
  }

  async cascade(): Promise<CascadeConfig> {
    return this.toCascade(await this.config());
  }

  async stt(): Promise<SpeechToText[]> {
    const cfg = await this.config();
    const o = { awsRegion: this.env.AWS_REGION, sarvamKey: this.env.SARVAM_API_KEY, whisperBaseUrl: this.env.OPENAI_COMPAT_BASE_URL, mock: this.mockStt };
    return [sttFromSpec(cfg.stt, o), sttFromSpec(cfg.sttFallback, o)].filter((s): s is SpeechToText => !!s);
  }

  /**
   * Validate + smoke-test a proposed config before saving. Rejects if any safety case is missed
   * or fewer than 10/12 cases pass, so a weaker model can't silently degrade patient handling.
   */
  async update(proposed: unknown, actorId: string, opts: { skipSmoke?: boolean } = {}): Promise<{ saved: boolean; smoke?: SmokeResult; reason?: string }> {
    const parsed = AiConfig.safeParse({ ...(await this.config()), ...(proposed as object) });
    if (!parsed.success) return { saved: false, reason: "invalid" };
    const cfg = parsed.data;
    for (const spec of [cfg.primary, cfg.escalation]) {
      if (!spec || spec === "rules") continue;
      if (!/^(bedrock|bedrock-tool|bedrock-mantle|anthropic-bedrock|anthropic|openai-compat):[\w.:/-]+$/.test(spec)) return { saved: false, reason: `bad_spec:${spec}` };
    }
    let smoke: SmokeResult | undefined;
    if (!opts.skipSmoke && cfg.primary !== "rules") {
      smoke = await smokeTest(this.toCascade(cfg));
      if (smoke.safetyMisses.length || smoke.passed < Math.ceil(smoke.total * 0.83)) return { saved: false, smoke, reason: "smoke_failed" };
    }
    await this.db.systemConfig.upsert({ where: { key: "ai" }, create: { key: "ai", value: cfg as never, updatedBy: actorId }, update: { value: cfg as never, updatedBy: actorId } });
    await this.db.auditLog.create({ data: { actorType: "DOCTOR", actorId, action: "settings.ai", entity: "SystemConfig", entityId: "ai", diff: { primary: cfg.primary, escalation: cfg.escalation } as never } });
    this.invalidate();
    return { saved: true, smoke };
  }

  catalog() { return MODEL_CATALOG; }
}
