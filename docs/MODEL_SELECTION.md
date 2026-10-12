# Language-model selection (bake-off, 10 Oct 2026)

**Decision: primary `bedrock-mantle:qwen.qwen3-32b` → failover `bedrock-mantle:mistral.mistral-large-3-675b-instruct`.**
Voice notes: `voxtral-small` (Mistral Voxtral Small 24B), with `voxtral-mini` as fallback.
All of these are open-weight models running in **AWS Mumbai (ap-south-1)** through the Bedrock "Mantle" OpenAI-compatible endpoint, so data stays in India.
The admin can switch any of these in **Settings → Language model** without a redeploy. Each change must pass a 12-message live smoke test, including every safety case, before it is saved.

## Method
- **Test set:** 140 dev cases plus **70 held-out cases** that were never used for tuning (`packages/ai/eval/{cases,holdout}.ts`). They cover booking, answers within a conversation, manage and status requests, clinic info, privacy commands, **health details** (must be flagged and never stored), **emergencies** (must be flagged), controls (no false flags), Devanagari Hindi, and noisy, voice-like text.
- **Scoring:** field-level exact match on intent, date, time, who, visit type and so on. Safety-flag recall and false-positive rate are scored separately.
- **Every model was first tested with a live single call** (all 14 returned HTTP 200 from Mumbai), then run on all 210 cases.
- **Prices:** AWS Pricing API, Bedrock ap-south-1 on-demand. ₹/msg assumes ₹88/$.
- **Reproduce:** `npm run eval:extract -- --set both --models <spec,…>` or `--cascade "<primary>><failover>"`. Reports go to `packages/ai/eval/reports/`.

## Round 1: all models, prompt v1 (210 cases)
| Model | All fields | Health recall | Emergency recall | p50 | ₹/msg |
|---|---|---|---|---|---|
| Mistral Large 3 (675B) | 94.8% | 100% | 100% | 612 ms | 0.114 |
| Qwen3 Coder 480B | 92.4% | 93.1% | 93.8% | 799 ms | 0.103 |
| Qwen3 VL 235B | 91.0% | 96.6% | 100% | 2330 ms | 0.121 |
| **Qwen3 32B** | **89.5%** | 96.6% | 93.8% | **357 ms** | **0.034** |
| Qwen3 Coder Next | 88.6% | 96.6% | 81.3% | 895 ms | 0.119 |
| Qwen3 235B A22B | 88.6% | 96.6% | 100% | 880 ms | 0.050 |
| Gemma 3 27B | 86.2% | 100% | 100% | 1243 ms | 0.047 |
| Ministral 3 14B | 83.8% | 96.6% | 100% | 532 ms | 0.041 |
| Gemma 3 12B | 83.3% | 93.1% | 100% | 733 ms | 0.021 |
| Rules only (no AI) | 82.4%* | 86.2% | 75% | 0 | 0 |
| Qwen3 Coder 30B | 76.7% | 100% | 87.5% | 367 ms | 0.035 |
| Magistral Small | 76.2% | 100% | 100% | 1780 ms | 0.119 |
| Ministral 3 8B | 74.8% | 86.2% | 87.5% | 461 ms | 0.031 |
| Ministral 3 3B | 66.7% | 93.1% | 87.5% | 361 ms | 0.021 |
| Gemma 3 4B | 54.3% | 89.7% | 93.8% | 503 ms | 0.009 |
\*Rules were tuned on the dev set. On the held-out set alone they score **55.7%**, so they are a fallback, not a solution.

## Improvements found from the errors (applied to all models)
1. **Calendar in context (prompt v2):** small models mis-computed weekdays (e.g., "Tuesday" became Monday). Each request now carries a 15-day calendar, so models look dates up instead of computing them.
2. **Better failover triggers:** escalate when the model disagrees with the deterministic rules on a date, an exact time, or a high-impact intent (cancel, reschedule, stop, delete data, arrived), in addition to low confidence, an invalid result or a timeout.
3. **Deterministic guards:** the script decides Hindi vs Hinglish. A status or info question that names a day or time is treated as a booking request. Two Hinglish self-harm phrases were added to the emergency keywords (they were missed by every model on held-out case x57, so that case is now contaminated for future comparisons).

## Round 2 / final: prompt v2
| Setup | Dev (140) | **Held-out (70)** | Health recall | Emergency recall | Failed over | p50 | ₹/msg |
|---|---|---|---|---|---|---|---|
| Mistral Large 3 alone | 96.2% | **98.6%** | 100% | 100% | — | 600 ms | 0.127 |
| **Qwen3 32B → Mistral Large 3** | **94.3%** | **94.3%** | **100%** | **100%** | 5–10% | **~365 ms** | **0.044–0.051** |
| Qwen3 32B alone | 92.4%* | 91.4% | 100% | **83.3%** | — | 359 ms | 0.038 |
| Ministral 3 14B alone | 90.0%* | — | 100% | 100% | — | 503 ms | 0.046 |
| Gemma 3 12B → Mistral Large 3 | 85.7%* | — | 100% | 100% | 6.7% | 745 ms | 0.031 |
\*dev and held-out combined.

**Why the cascade:**
- It gives **100% safety recall on both sets** and the same accuracy on unseen messages as on the dev set, so it isn't overfitted.
- It is fast (p50 ~365 ms) at about **⅓ of Mistral Large's cost**.
- The remaining ~6% of field errors are mostly recoverable in conversation, because every booking is confirmed by tapping a slot. Examples: "Thanks doctor, see you Monday" read as OTHER, or "pehla wala" not mapped to the first offered slot.

In the live system, safety is also covered by an in-memory emergency keyword check that runs before any model, and health-detail flags are OR-ed with the rules.

**When to switch:** for maximum accuracy, set Primary = Mistral Large 3 and Failover = Qwen3 235B in Settings. Held-out accuracy is 98.6%, at about ₹0.13/msg.
At about 150 free-text messages a day, the monthly AI cost is **≈ ₹200 (cascade)** or **≈ ₹575 (Mistral Large)**. Button taps cost nothing because they skip the model.

## Voice notes
| Model | English sample | Hindi sample | Latency |
|---|---|---|---|
| **Voxtral Small 24B** | verbatim | **verbatim, in Devanagari** | ~600 ms |
| Voxtral Mini 3B | verbatim | translated to English (meaning kept) | ~200–400 ms |
| Amazon Transcribe | blocked on this account ("SubscriptionRequired", Free plan) | | |
WhatsApp voice notes (OGG/Opus) are decoded to 16 kHz WAV **in memory** (WebAssembly decoder) before transcription. **Go-live check:** send a real voice note from a phone on the Meta test number.

## Not tested (account limits)
gpt-oss-20b/120b and Claude Haiku 4.5 on classic Bedrock are blocked by Free-plan quotas and the Marketplace payment requirement (see `docs/runbooks/aws-bedrock-access.md`). Adapters for both are built; after the account upgrade, re-run the bake-off with `--models bedrock:openai.gpt-oss-120b-1:0,anthropic-bedrock:in.anthropic.claude-haiku-4-5-20251001-v1:0`.

### Change log
- **12 Oct 2026:** prompt `2026-10-12.2` adds three intents, `WAIT`, `RUDE` and `HELP`, after a patient's "Stupid" / "Hold" / "Stop it now"
  were answered with the same question. The first wording made the model call "I'll be 10 min late" `WAIT` and "Stop it now" `STOP`;
  the prompt now says being late is not `WAIT`, and "stop it / stop repeating" is `RUDE`. 14 dev cases added (o01–o14), none to the
  held-out set. Cascade: **96.0% all-fields, 96.9% critical** (was 95.7%), health and emergency recall 100%; all 14 new cases pass.
- **11 Oct 2026:** two deterministic guards were refined after real-phone testing.
  - Numbers that are durations, counts or amounts ("3 din se", "2 weeks", "₹500", "5 saal") no longer count as evidence of a time.
  - A timings question that names a day but no time ("open on Sunday?") stays a clinic-info question.
  - Held-out case **x69** ("doc available on mon? @ 7") was looked at while scoping the second rule, so it is now contaminated, like x57.
  - Final cascade run: **94.8% all-fields** (baseline 94.3%), with health and emergency recall at 100%. Unchanged cases vary by about ±2 points between runs: b04, h09, x17, x32 and x67 flipped in an intermediate run with no related change.
