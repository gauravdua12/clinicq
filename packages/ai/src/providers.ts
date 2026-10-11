import { BedrockRuntimeClient, ConverseCommand, type ContentBlock } from "@aws-sdk/client-bedrock-runtime";
import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { Extraction, type ModelHandle, type ModelResult } from "@clinicq/core/extract/index";

// Model adapters behind one interface (docs/AI_EXTRACTION.md §4). Each returns raw JSON;
// validation happens once in the shared cascade so every model meets the same contract.
// Patient text passes through in memory only — nothing here logs prompts or completions.

export interface ProviderOptions {
  awsRegion?: string;
  openaiCompatBaseUrl?: string;
  openaiCompatApiKey?: string;
  anthropicApiKey?: string;
}

const TOOL_NAME = "record_extraction";
const TOOL_DESC = "Record the structured understanding of the patient's message.";
let jsonSchemaCache: Record<string, unknown> | null = null;
function extractionJsonSchema(): Record<string, unknown> {
  if (!jsonSchemaCache) {
    const s = z.toJSONSchema(Extraction, { target: "draft-7" }) as Record<string, unknown>;
    delete s.$schema;
    jsonSchemaCache = s;
  }
  return jsonSchemaCache;
}

/** Pull the first balanced JSON object out of model text (tolerates ``` fences and <think> blocks). */
export function parseJsonFromText(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "");
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

const bedrockClients = new Map<string, BedrockRuntimeClient>();
function bedrock(region: string): BedrockRuntimeClient {
  let c = bedrockClients.get(region);
  if (!c) { c = new BedrockRuntimeClient({ region, maxAttempts: 1 }); bedrockClients.set(region, c); }
  return c;
}

/** Per-model request tweaks discovered during the bake-off. */
function bedrockExtras(modelId: string): { additional?: Record<string, string | number | boolean>; suffix?: string; maxTokens: number } {
  if (modelId.includes("gpt-oss")) return { additional: { reasoning_effort: "low" }, maxTokens: 1200 };
  if (modelId.includes("qwen3") && !modelId.includes("next")) return { suffix: "\n/no_think", maxTokens: 900 };
  if (modelId.includes("nemotron")) return { suffix: "\n/no_think", maxTokens: 900 };
  if (modelId.includes("glm")) return { maxTokens: 1200 };
  return { maxTokens: 600 };
}

export function bedrockConverse(modelId: string, region: string, mode: "json" | "tool" = "json"): ModelHandle {
  const spec = `bedrock:${modelId}`;
  return {
    spec,
    async call(system: string, user: string, timeoutMs: number): Promise<ModelResult> {
      const x = bedrockExtras(modelId);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const cmd = new ConverseCommand({
          modelId,
          system: [{ text: system }],
          messages: [{ role: "user", content: [{ text: user + (x.suffix ?? "") }] }],
          inferenceConfig: { maxTokens: x.maxTokens, temperature: 0 },
          ...(x.additional ? { additionalModelRequestFields: x.additional as never } : {}),
          ...(mode === "tool"
            ? { toolConfig: { tools: [{ toolSpec: { name: TOOL_NAME, description: TOOL_DESC, inputSchema: { json: extractionJsonSchema() as never } } }], toolChoice: { tool: { name: TOOL_NAME } } } }
            : {}),
        });
        const res = await bedrock(region).send(cmd, { abortSignal: ac.signal });
        const blocks: ContentBlock[] = res.output?.message?.content ?? [];
        let json: unknown = null;
        for (const b of blocks) if (b.toolUse?.input) { json = b.toolUse.input; break; }
        if (json === null) json = parseJsonFromText(blocks.map((b) => b.text ?? "").join("\n"));
        return { json, inputTokens: res.usage?.inputTokens, outputTokens: res.usage?.outputTokens };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function anthropicToolCall(client: Anthropic | AnthropicBedrock, model: string, spec: string): ModelHandle {
  return {
    spec,
    async call(system: string, user: string, timeoutMs: number): Promise<ModelResult> {
      const res = await client.messages.create(
        {
          model,
          max_tokens: 600,
          system,
          messages: [{ role: "user", content: user }],
          tools: [{ name: TOOL_NAME, description: TOOL_DESC, input_schema: extractionJsonSchema() as Anthropic.Tool.InputSchema }],
          tool_choice: { type: "tool", name: TOOL_NAME },
        },
        { timeout: timeoutMs, maxRetries: 0 },
      );
      const tool = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
      return { json: tool?.input ?? parseJsonFromText(text), inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
    },
  };
}

export function anthropicOnBedrock(model: string, region: string): ModelHandle {
  return anthropicToolCall(new AnthropicBedrock({ awsRegion: region }), model, `anthropic-bedrock:${model}`);
}

export function anthropicDirect(model: string, apiKey?: string): ModelHandle {
  return anthropicToolCall(new Anthropic(apiKey ? { apiKey } : {}), model, `anthropic:${model}`);
}

/** Self-hosted open-source models (vLLM, Ollama, llama.cpp server, TGI) via an OpenAI-compatible API. */
export function openaiCompatible(model: string, baseUrl: string, apiKey?: string): ModelHandle {
  return {
    spec: `openai-compat:${model}`,
    async call(system: string, user: string, timeoutMs: number): Promise<ModelResult> {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 800,
          response_format: { type: "json_object" },
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw Object.assign(new Error("openai_compat_http"), { status: res.status });
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      return { json: parseJsonFromText(body.choices?.[0]?.message?.content ?? ""), inputTokens: body.usage?.prompt_tokens, outputTokens: body.usage?.completion_tokens };
    },
  };
}

// Amazon Bedrock "Mantle" OpenAI-compatible endpoint (in-region open-weight models), SigV4-signed.
let mantleSigner: { region: string; signer: SignatureV4 } | null = null;
function signer(region: string): SignatureV4 {
  if (!mantleSigner || mantleSigner.region !== region) mantleSigner = { region, signer: new SignatureV4({ credentials: defaultProvider(), region, service: "bedrock", sha256: Sha256 }) };
  return mantleSigner.signer;
}

function mantleExtras(model: string): { suffix?: string; maxTokens: number; jsonMode: boolean } {
  if (/qwen3(?!-coder)/.test(model) && !model.includes("instruct")) return { suffix: "\n/no_think", maxTokens: 900, jsonMode: true };
  if (model.includes("magistral")) return { maxTokens: 1500, jsonMode: false };
  return { maxTokens: 700, jsonMode: true };
}

/** Signed POST to the Bedrock Mantle OpenAI-compatible endpoint. */
export async function mantlePost(region: string, path: string, payload: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
  const host = `bedrock-mantle.${region}.api.aws`;
  const body = JSON.stringify(payload);
  const req = await signer(region).sign({ method: "POST", protocol: "https:", hostname: host, path, headers: { host, "content-type": "application/json" }, body });
  const res = await fetch(`https://${host}${path}`, { method: "POST", headers: req.headers as Record<string, string>, body, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const name = res.status === 429 ? "ThrottlingException" : res.status >= 500 ? "ServiceUnavailable" : "MantleHttpError";
    throw Object.assign(new Error(`mantle_${res.status}`), { name, status: res.status });
  }
  return (await res.json()) as Record<string, unknown>;
}

export function bedrockMantle(model: string, region: string): ModelHandle {
  return {
    spec: `bedrock-mantle:${model}`,
    async call(system: string, user: string, timeoutMs: number): Promise<ModelResult> {
      const x = mantleExtras(model);
      const host = `bedrock-mantle.${region}.api.aws`;
      const body = JSON.stringify({
        model, temperature: 0, max_tokens: x.maxTokens,
        ...(x.jsonMode ? { response_format: { type: "json_object" } } : {}),
        messages: [{ role: "system", content: system }, { role: "user", content: user + (x.suffix ?? "") }],
      });
      const req = await signer(region).sign({ method: "POST", protocol: "https:", hostname: host, path: "/v1/chat/completions", headers: { host, "content-type": "application/json" }, body });
      const res = await fetch(`https://${host}/v1/chat/completions`, { method: "POST", headers: req.headers as Record<string, string>, body, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        const name = res.status === 429 ? "ThrottlingException" : res.status >= 500 ? "ServiceUnavailable" : "MantleHttpError";
        throw Object.assign(new Error(`mantle_${res.status}`), { name, status: res.status });
      }
      const j = (await res.json()) as { choices?: { message?: { content?: string; reasoning_content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      return { json: parseJsonFromText(j.choices?.[0]?.message?.content ?? ""), inputTokens: j.usage?.prompt_tokens, outputTokens: j.usage?.completion_tokens };
    },
  };
}

/** "bedrock:<modelId>" | "bedrock-tool:<modelId>" | "anthropic-bedrock:<id>" | "anthropic:<model>" | "openai-compat:<model>" | "rules" | "" */
export function modelFromSpec(spec: string | null | undefined, opts: ProviderOptions): ModelHandle | null {
  if (!spec || spec === "rules" || spec === "none") return null;
  const i = spec.indexOf(":");
  const kind = spec.slice(0, i);
  const id = spec.slice(i + 1);
  const region = opts.awsRegion ?? "ap-south-1";
  switch (kind) {
    case "bedrock": return bedrockConverse(id, region, "json");
    case "bedrock-mantle": return bedrockMantle(id, region);
    case "bedrock-tool": return { ...bedrockConverse(id, region, "tool"), spec };
    case "anthropic-bedrock": return anthropicOnBedrock(id, region);
    case "anthropic": return anthropicDirect(id, opts.anthropicApiKey);
    case "openai-compat":
      if (!opts.openaiCompatBaseUrl) throw new Error("OPENAI_COMPAT_BASE_URL not set");
      return openaiCompatible(id, opts.openaiCompatBaseUrl, opts.openaiCompatApiKey);
    default: throw new Error(`Unknown model spec: ${spec}`);
  }
}
