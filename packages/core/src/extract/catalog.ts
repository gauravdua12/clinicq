// Model catalogue for the admin "Language model" setting and the bake-off.
// Prices: USD per 1M tokens, Amazon Bedrock ap-south-1 on-demand (AWS Pricing API, 2026-10-10).
// residency: "in" = processed inside India (Mumbai in-region or the India geo profile);
//            "apac"/"global" = may be processed outside India.

export interface CatalogModel {
  spec: string;
  label: string;
  openWeight: boolean;
  residency: "in" | "apac" | "global" | "self-hosted";
  inPerM: number | null;
  outPerM: number | null;
  tier: "economy" | "standard" | "superior";
}

export const MODEL_CATALOG: CatalogModel[] = [
  // In-region (Mumbai) open-weight models available on this AWS account via the Bedrock Mantle endpoint.
  { spec: "bedrock-mantle:google.gemma-3-4b-it", label: "Gemma 3 4B", openWeight: true, residency: "in", inPerM: 0.05, outPerM: 0.09, tier: "economy" },
  { spec: "bedrock-mantle:google.gemma-3-12b-it", label: "Gemma 3 12B", openWeight: true, residency: "in", inPerM: 0.11, outPerM: 0.34, tier: "economy" },
  { spec: "bedrock-mantle:google.gemma-3-27b-it", label: "Gemma 3 27B", openWeight: true, residency: "in", inPerM: 0.27, outPerM: 0.45, tier: "standard" },
  { spec: "bedrock-mantle:mistral.ministral-3-3b-instruct", label: "Ministral 3 3B", openWeight: true, residency: "in", inPerM: 0.12, outPerM: 0.12, tier: "economy" },
  { spec: "bedrock-mantle:mistral.ministral-3-8b-instruct", label: "Ministral 3 8B", openWeight: true, residency: "in", inPerM: 0.18, outPerM: 0.18, tier: "economy" },
  { spec: "bedrock-mantle:mistral.ministral-3-14b-instruct", label: "Ministral 3 14B", openWeight: true, residency: "in", inPerM: 0.24, outPerM: 0.24, tier: "economy" },
  { spec: "bedrock-mantle:mistral.magistral-small-2509", label: "Magistral Small 1.2", openWeight: true, residency: "in", inPerM: 0.59, outPerM: 1.76, tier: "standard" },
  { spec: "bedrock-mantle:qwen.qwen3-32b", label: "Qwen3 32B", openWeight: true, residency: "in", inPerM: 0.18, outPerM: 0.71, tier: "standard" },
  { spec: "bedrock-mantle:qwen.qwen3-coder-30b-a3b-instruct", label: "Qwen3 Coder 30B A3B", openWeight: true, residency: "in", inPerM: 0.18, outPerM: 0.71, tier: "economy" },
  { spec: "bedrock-mantle:qwen.qwen3-coder-next", label: "Qwen3 Coder Next", openWeight: true, residency: "in", inPerM: 0.6, outPerM: 2.4, tier: "standard" },
  { spec: "bedrock-mantle:qwen.qwen3-235b-a22b-2507", label: "Qwen3 235B A22B", openWeight: true, residency: "in", inPerM: 0.26, outPerM: 1.06, tier: "superior" },
  { spec: "bedrock-mantle:qwen.qwen3-vl-235b-a22b-instruct", label: "Qwen3 VL 235B A22B", openWeight: true, residency: "in", inPerM: 0.6, outPerM: 3.13, tier: "superior" },
  { spec: "bedrock-mantle:qwen.qwen3-coder-480b-a35b-instruct", label: "Qwen3 Coder 480B", openWeight: true, residency: "in", inPerM: 0.53, outPerM: 2.12, tier: "superior" },
  { spec: "bedrock-mantle:mistral.mistral-large-3-675b-instruct", label: "Mistral Large 3 675B", openWeight: true, residency: "in", inPerM: 0.59, outPerM: 1.76, tier: "superior" },
  // Need account changes (Paid plan + quotas) — kept for later comparison.
  { spec: "bedrock:openai.gpt-oss-20b-1:0", label: "gpt-oss-20b", openWeight: true, residency: "in", inPerM: 0.08, outPerM: 0.35, tier: "economy" },
  { spec: "bedrock:openai.gpt-oss-120b-1:0", label: "gpt-oss-120b", openWeight: true, residency: "in", inPerM: 0.18, outPerM: 0.71, tier: "standard" },
  { spec: "anthropic-bedrock:in.anthropic.claude-haiku-4-5-20251001-v1:0", label: "Claude Haiku 4.5 (India)", openWeight: false, residency: "in", inPerM: 1.1, outPerM: 5.5, tier: "superior" },
];

export function catalogEntry(spec: string): CatalogModel | undefined {
  return MODEL_CATALOG.find((m) => m.spec === spec);
}

export function costUsd(spec: string, inputTokens = 0, outputTokens = 0): number | null {
  const m = catalogEntry(spec);
  if (!m || m.inPerM == null || m.outPerM == null) return null;
  return (inputTokens * m.inPerM + outputTokens * m.outPerM) / 1_000_000;
}
