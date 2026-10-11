# Extraction bake-off 2026-10-10T13-06-40
Prompt 2026-10-10.2 · set=holdout · 70 cases × 1

| Model | Valid % | All-fields % | Critical % | Intent % | Medical recall % | Medical FP % | Emergency recall % | Emergency FP % | Escalated % | p50 ms | p95 ms | ₹/msg | $/1k msgs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bedrock-mantle:mistral.mistral-large-3-675b-instruct | 100 | 98.6 | 98.6 | 98.2 | 100 | 0 | 100 | 0 | – | 610 | 830 | 0.127 | 1.446 |
| bedrock-mantle:qwen.qwen3-32b > bedrock-mantle:mistral.mistral-large-3-675b-instruct | 100 | 94.3 | 95.7 | 96.5 | 100 | 0 | 100 | 0 | 10 | 371 | 986 | 0.051 | 0.578 |
| bedrock-mantle:qwen.qwen3-32b | 100 | 91.4 | 94.3 | 96.5 | 100 | 0 | 83.3 | 0 | – | 352 | 415 | 0.038 | 0.434 |
