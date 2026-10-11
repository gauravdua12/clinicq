# Unblocking Amazon Bedrock on the AWS account

Status on 2026-10-10 (account 068381294079):
- Free plan account → Marketplace subscriptions fail (`INVALID_PAYMENT_INSTRUMENT`). This blocks the Claude models.
- Bedrock on-demand quotas in **ap-south-1 = 0**, and non-adjustable in Service Quotas. us-west-2 has a small daily token cap.

## Step 1: Upgrade to the Paid plan (keeps your credits)
Billing and Cost Management → **Free plan** banner → **Upgrade plan**. Check that a valid card is set as the default payment method (Billing → Payment preferences). Remaining credits still apply after the upgrade.

## Step 2: Open a support case (free "Basic" support is enough)
Support Center → Create case → **Account and billing**, or **Service limit increase** → Service: **Amazon Bedrock**, Region **Asia Pacific (Mumbai)**.

Suggested text:
> We are building a WhatsApp appointment assistant for a doctor's clinic in India (about 60 patients per day). It uses Amazon Bedrock in ap-south-1 for short text-understanding requests: about 1,500 input and 300 output tokens per request, roughly 2,000 requests per day at peak.
>
> All on-demand Bedrock quotas in ap-south-1 show an applied value of 0 (non-adjustable), and requests fail with "ThrottlingException: Too many tokens per day". The account has been upgraded to the Paid plan with a valid payment method.
>
> Please apply the default on-demand quotas in ap-south-1 for:
> - openai.gpt-oss-20b-1:0, openai.gpt-oss-120b-1:0
> - google.gemma-3-4b-it, google.gemma-3-12b-it, google.gemma-3-27b-it
> - mistral.ministral-3-3b/8b/14b-instruct
> - qwen.qwen3-32b-v1:0, nvidia.nemotron-nano-9b-v2
> - Claude Haiku 4.5 via the India geographic inference profile in.anthropic.claude-haiku-4-5-20251001-v1:0
> - amazon.nova-micro / nova-lite (APAC profile)
>
> Needed: at least 100 requests/min and 200,000 tokens/min per model, and no daily token cap below 5M tokens. Also, please enable the account for Amazon Transcribe streaming in ap-south-1.

## Step 3: Verify (I can run this)
```bash
aws service-quotas list-service-quotas --service-code bedrock --region ap-south-1 \
  --query "Quotas[?contains(QuotaName,'GPT OSS 20B')].[QuotaName,Value]" --output text
npm run eval:extract -- --set dev --only b01 --models bedrock:openai.gpt-oss-20b-1:0
```
