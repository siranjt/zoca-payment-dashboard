# Deploy — step by step

Run every command from inside this folder on your Mac:

```bash
cd "/Users/siranjiththangavel/Library/Application Support/Claude/local-agent-mode-sessions/dd0adf1f-69ed-417e-a092-df14239bb6a8/e4c300ef-d52f-45b0-b74d-ee9089598f69/local_a2b8e1e9-9c92-45f8-979b-e0589109e889/outputs/zoca-payment-dashboard"
```

(Or just open a terminal in this folder via Cowork.)

## 0. Prerequisites

```bash
# Verify tooling
git --version           # any modern git
node --version          # v20+
npm --version

# Install global CLIs if you don't have them
brew install gh         # GitHub CLI — optional but easiest path
npm i -g vercel         # Vercel CLI
```

If you don't have the GitHub CLI you'll create the repo via the web UI in step 2; otherwise `gh repo create` is one command.

## 1. Reset git and make a clean first commit

A previous git init in this folder was left half-finished by a sandbox process. Reset it cleanly:

```bash
rm -rf .git
git init -b main
git config user.email "success@zoca.com"
git config user.name  "Siranjith Thangavel"     # or whatever you prefer
git add -A
git commit -m "init: Zoca Payment Validator Dashboard scaffold"
```

You should see ~28 files staged.

## 2. Create the GitHub repo and push

**Option A — with the GitHub CLI (one command):**

```bash
gh repo create zoca-ai/zoca-payment-dashboard --private --source=. --push
```

**Option B — manual:**

1. Go to https://github.com/organizations/zoca-ai/repositories/new
2. Name: `zoca-payment-dashboard` · Visibility: Private · **Do NOT** init with README
3. Click "Create repository"
4. Then back in your terminal:

```bash
git remote add origin git@github.com:zoca-ai/zoca-payment-dashboard.git
git push -u origin main
```

## 3. Link to Vercel

```bash
vercel login                                    # if not already logged in
vercel link
```

When prompted:
- "Set up… ?" → **Y**
- "Which scope?" → **siranjts-projects** (your team)
- "Link to existing project?" → **N**
- "Project name?" → **zoca-payment-dashboard** (accept default)
- "Directory?" → press enter (current dir)

This creates `.vercel/project.json`. Don't commit it (already in `.gitignore`).

## 4. Provision Postgres + Blob storage on Vercel

In your browser, open https://vercel.com/siranjts-projects/zoca-payment-dashboard/stores

- **Add Database → Postgres** — create one (any name). It will auto-link to the project. Env vars `POSTGRES_URL`, `POSTGRES_PRISMA_URL`, `POSTGRES_URL_NON_POOLING` are auto-injected.
- **Add Database → Blob** — create one (any name). `BLOB_READ_WRITE_TOKEN` is auto-injected.

You'll see them appear under the project's "Storage" tab.

## 5. Add the rest of the env vars

Each command will prompt you for the value:

```bash
vercel env add CHARGEBEE_API_KEY        production   # live_K26QwUdeX37fHKmMe1pkobqGOZ9jGHWF
vercel env add CHARGEBEE_WEBHOOK_SECRET production   # any strong random string — save it; you'll paste this same value into Chargebee in step 8
vercel env add STRIPE_API_KEY           production   # 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
vercel env add METABASE_API_KEY         production   # mb_HMtn6VnGpYObdOeA7/W5IXEbExApEEWRW5E88bwTodE=
vercel env add ANTHROPIC_API_KEY        production   # get one at https://console.anthropic.com/settings/keys
vercel env add ANTHROPIC_MODEL          production   # claude-opus-4-6
vercel env add SLACK_CHANNEL_ID         production   # C0B2ECQMDR9
vercel env add SLACK_BOT_TOKEN          production   # OPTIONAL — leave blank to skip native .docx upload; press enter for empty value
vercel env add CUSTOMER_FLOOR_DATE      production   # 2026-05-01
vercel env add DISCOVERY_FILTER_PATTERN production   # discovery
vercel env add COMMS_WINDOW_DAYS        production   # 90
vercel env add TIMESTAMP_MISMATCH_HOURS production   # 24
```

For `NEXT_PUBLIC_APP_URL`, wait until step 6 produces a URL, then come back:

```bash
vercel env add NEXT_PUBLIC_APP_URL      production   # https://<your-vercel-url>
```

## 6. First deploy (to get the production URL)

```bash
vercel deploy --prod
```

The CLI prints a URL like `https://zoca-payment-dashboard-xxxxx-siranjts-projects.vercel.app`. Note it for the next steps.

Now add the URL back as `NEXT_PUBLIC_APP_URL` (step 5 final var), then redeploy so the Slack message links use the right host:

```bash
vercel env add NEXT_PUBLIC_APP_URL production
vercel deploy --prod
```

## 7. Run the DB migration

The `customers` and `events` tables don't exist until you create them.

```bash
vercel env pull .env.production.local
npm install
npm run db:migrate
```

You should see ~6 statements succeed.

## 8. Wire up the Chargebee webhook

1. Open Chargebee → **Settings** → **Webhooks** → **Add a new Webhook**
2. **Webhook URL:** `https://<your-vercel-url>/api/cb-webhook`
3. **Username:** `zoca` (anything works — we don't check the username)
4. **Password:** the same value you set as `CHARGEBEE_WEBHOOK_SECRET` in step 5
5. **Events to send:** check these three only —
   - `customer_created`
   - `subscription_created`
   - `subscription_activated`
6. **Save**
7. Click **Test webhook** — pick `customer_created` and click Send. Your dashboard at `https://<your-vercel-url>/` should show a row appear within seconds.

## 9. (Optional) Backfill customers since 2026-05-01

If you want every customer created since the floor in the dashboard (not just the ones created after the webhook went live), run the backfill once:

```bash
APP_URL=https://<your-vercel-url> npm run backfill
```

It walks every Chargebee customer with `created_at >= 2026-05-01` and POSTs `/api/analyze/<id>` for each. Discovery first-pay customers get the full pipeline; others get marked out-of-scope.

## 10. Test end-to-end on Be Beauty Studio

Force a single-customer analyze run for the known test customer:

```bash
curl -X POST https://<your-vercel-url>/api/analyze/16A2rRVIyq4cQjAV \
  -H "content-type: application/json" -d '{}'
```

Then check:
- Your dashboard `/` should show Be Beauty Studio with verdict `❌ Not ICP`
- Click "Open report →" — the report viewer opens
- Slack channel `#new-payment-analysis` gets the verdict + flags + thread analysis

If the verdict in the dashboard says `pending` after 60 s, check the Vercel function logs:

```bash
vercel logs --prod
```

## Quick troubleshooting

| Symptom | Fix |
|---|---|
| Dashboard shows DB connection error | `vercel env pull .env.production.local && npm run db:migrate` |
| Webhook fires but no row appears | Check `vercel logs` — auth header probably wrong. The Chargebee password must match `CHARGEBEE_WEBHOOK_SECRET` exactly |
| LLM evaluator fails with rate-limit | Open Anthropic console → upgrade the API key's rate limit, or lower concurrency in the analyze route |
| docx render times out | `vercel.json` already sets `maxDuration: 300`. If it still times out, the comms CSVs are too large — pre-cache them or move the analyze route to a Vercel Cron + Queue pattern |
| Slack post fails with `not_in_channel` | Add the bot to `#new-payment-analysis` first: `/invite @YourBot` |
| Slack `.docx` upload fails | Your `SLACK_BOT_TOKEN` lacks `files:write` scope — add it in the Slack app config |

## Future updates

To deploy a new version after a code change:

```bash
git add -A && git commit -m "describe change"
git push                              # triggers automatic Vercel deploy
# OR force a deploy:
vercel deploy --prod
```

To edit the LLM prompt or the report layout without re-deploying:

- `prompt.md` — edit, commit, push. Next analyze run picks it up.
- `lib/render/template.js` — same.

That's it. Ping me here if any step fails — paste the error, I'll debug.
