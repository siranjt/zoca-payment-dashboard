# Zoca Payment Validator Dashboard

Per-customer Post-Payment Account Review pipeline.

When a Chargebee customer is created, this dashboard:

1. Receives the `customer_created` and `subscription_created` webhooks from Chargebee
2. If the first subscription is on Discovery, runs the full validator + LLM evaluator pipeline
3. Generates a Word doc (Module-02 ICP review) and uploads it to Vercel Blob
4. Posts a short summary + dashboard link to Slack `#new-payment-analysis`
5. Logs the customer in Postgres so the dashboard can list every CB customer since the floor date

The dashboard at `/` lists every customer created on or after `CUSTOMER_FLOOR_DATE` (default 2026-05-01). Click "Open report" to see the full review.

## Architecture

```
Chargebee customer.created      Vercel
       ↓                          │
POST /api/cb-webhook ─────────────┤
       │ verify Basic-auth        │
       │ insert customers row     │
       │ if Discovery: fire-and-forget POST /api/analyze/<id>
       ↓
POST /api/analyze/<id>
       │ buildBundle (lib/validator/*)        — Chargebee + Stripe + Metabase + BaseSheet
       │ evaluate (lib/evaluator/*)           — Anthropic API with prompt.md
       │ renderAndUpload (lib/render/*)       — docx + Vercel Blob
       │ postCustomerReport (lib/slack.ts)    — verdict + flags + dashboard link
       ↓
DB updated · Slack posted · Word doc on Blob CDN
```

## Tech stack

- **Next.js 14** (App Router) on Vercel
- **Vercel Postgres** for `customers` + `events` tables
- **Vercel Blob** for storing rendered .docx + .json + .md per customer
- **Anthropic Claude** for the LLM evaluator (the prompt is in `prompt.md`)
- **docx** library (the same template used by the validator's render_report.js)
- **Tailwind** for styling

## Environment variables

See `.env.example`. The key ones:

| Variable | Purpose |
|---|---|
| `POSTGRES_URL` | Vercel Postgres (auto-injected on `vercel link`) |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob (auto-injected) |
| `CHARGEBEE_API_KEY` | Chargebee REST API |
| `CHARGEBEE_WEBHOOK_SECRET` | Shared secret you set when creating the webhook |
| `STRIPE_API_KEY` | Stripe customer lookup (read-only restricted key OK) |
| `METABASE_API_KEY` | Metabase CSV downloads |
| `ANTHROPIC_API_KEY` | LLM evaluator |
| `SLACK_BOT_TOKEN` | (optional) for native Slack file upload |
| `SLACK_CHANNEL_ID` | `C0B2ECQMDR9` (#new-payment-analysis) |
| `NEXT_PUBLIC_APP_URL` | Public URL for dashboard links in Slack messages |
| `CUSTOMER_FLOOR_DATE` | `2026-05-01` (default) |

## Deploy steps

1. **Create the GitHub repo** and push:
   ```bash
   cd zoca-payment-dashboard
   git init && git add -A && git commit -m "init: payment validator dashboard"
   git remote add origin git@github.com:zoca-ai/zoca-payment-dashboard.git
   git push -u origin main
   ```

2. **Create the Vercel project**:
   ```bash
   vercel link
   # Choose: scope=siranjts-projects, project=zoca-payment-dashboard
   ```

3. **Provision Vercel Postgres** (Vercel Dashboard → Storage → Create Database → Postgres):
   - Connect to the project; env vars auto-inject.

4. **Provision Vercel Blob** (Vercel Dashboard → Storage → Create Database → Blob):
   - Connect to the project; `BLOB_READ_WRITE_TOKEN` auto-injects.

5. **Set the rest of the env vars**:
   ```bash
   vercel env add CHARGEBEE_API_KEY production
   vercel env add CHARGEBEE_WEBHOOK_SECRET production
   vercel env add STRIPE_API_KEY production
   vercel env add METABASE_API_KEY production
   vercel env add ANTHROPIC_API_KEY production
   vercel env add SLACK_CHANNEL_ID production           # value: C0B2ECQMDR9
   vercel env add SLACK_BOT_TOKEN production            # optional
   vercel env add CUSTOMER_FLOOR_DATE production        # value: 2026-05-01
   vercel env add NEXT_PUBLIC_APP_URL production        # value: https://<your-vercel-url>
   ```

6. **Run the DB migration**:
   ```bash
   vercel env pull .env.production.local
   POSTGRES_URL="$(grep POSTGRES_URL .env.production.local | cut -d= -f2-)" npm run db:migrate
   ```

7. **Deploy**:
   ```bash
   vercel deploy --prod
   ```

8. **Configure the Chargebee webhook**:
   - Chargebee Dashboard → Settings → Webhooks → Add Webhook
   - URL: `https://<your-vercel-url>/api/cb-webhook`
   - Username: `zoca` (any value)
   - Password: same value you set as `CHARGEBEE_WEBHOOK_SECRET`
   - Events to subscribe: `customer_created`, `subscription_created`, `subscription_activated`
   - Save and click "Test" — your dashboard should show a row appear.

9. **(Optional) Backfill** any customers created before the webhook was wired:
   ```bash
   APP_URL=https://<your-vercel-url> npm run backfill
   ```

## Local development

```bash
npm install
cp .env.example .env.local
# Fill in env vars, including a local Postgres URL
npm run db:migrate
npm run dev
# http://localhost:3000
```

To test the webhook locally, use `vercel dev` + ngrok, or POST a sample payload directly:

```bash
curl -X POST http://localhost:3000/api/cb-webhook \
  -H "authorization: Basic $(echo -n 'admin:dev-secret' | base64)" \
  -H "content-type: application/json" \
  -d @samples/customer_created.json
```

## What gets analyzed (the contract — same for every customer)

The pipeline analyzes the same metrics for every new Chargebee customer. See [docs/metrics.md](./docs/metrics.md) for the full list. Summary:

- **Identity & timing**: Chargebee + Stripe customer-creation timestamps (mismatch flagged), sales cycle
- **Subscription**: SKU, billing cadence, Discovery match, first-ever-sub check
- **Communications (90-day window)**: 5 channels (App Chat, Email, Phone, SMS, Video) inbound + outbound
- **GBP demand metrics**: `predicted_6_month_leads` (decisive Step 1.2 gate per tier rule), reviews, profile clicks
- **Booking platform**: One of the 5 qualifying platforms? Active?
- **GBP age**: opening date or earliest review (data-gap if neither)
- **BaseSheet enrichment**: AE, AM, lead source, churn flags, ticket counts
- **HubSpot enrichment**: lead source, deal context
- **Fireflies enrichment**: demo / discovery transcripts
- **Module 02 framework**: Vertical lock + Step 1 (3 hard rules) + Step 2 (row + Rule A/B) + 7 additional disqualifiers
- **11 LLM-judgment pointers**: lead source, outreach content, comms timing, demo call, sales pushiness, financial mentions, ICP fit, intent, expectations, retention red flags, pricing/discount

Output verdict: `✅ ICP` / `⚠️ Review` / `❌ Not ICP`, with a `🚨 Needs AM call` flag.

## Editing the prompt or schema

- **Tweak the rules** → edit `prompt.md`. The LLM's JSON output adapts on next run.
- **Tweak the layout** → edit `lib/render/template.js`. Schema stays the same.
- **Tweak the schema** → update `report_schema.example.json` AND the JSON output spec in `prompt.md` AND the template.

## File map

```
app/
├── layout.tsx                            App shell + header
├── page.tsx                              Dashboard list
├── globals.css                           Tailwind + base styles
├── reports/[customer_id]/page.tsx        Single-report viewer
└── api/
    ├── cb-webhook/route.ts               Chargebee webhook receiver
    └── analyze/[customer_id]/route.ts    Full pipeline orchestrator

lib/
├── db/
│   ├── schema.sql                        Postgres DDL
│   └── queries.ts                        All SQL in one place
├── validator/
│   ├── chargebee.ts                      Chargebee REST client
│   ├── stripe.ts                         Stripe customer lookup
│   ├── metabase.ts                       Metabase CSV fetchers + filters
│   └── bundle.ts                         Validator orchestrator (TS port of payment_validator.py)
├── evaluator/
│   └── anthropic.ts                      LLM evaluator with retry-once-on-JSON-fail
├── render/
│   ├── template.js                       Word-doc template (parameterised, shared with validator)
│   └── render.ts                         Renders + uploads to Vercel Blob
└── slack.ts                              Slack post + optional .docx upload

scripts/
├── migrate.mjs                           Run schema.sql
└── backfill.mjs                          Backfill customers since floor

prompt.md                                 LLM evaluator prompt (editable)
report_schema.example.json                Worked example for the JSON output schema
```

## Confidentiality

This dashboard contains pre-purchase customer evidence (call transcripts, email content, financial signals) and per-account business decisions. It is **internal-only**. Do not redistribute outside Zoca leadership.
