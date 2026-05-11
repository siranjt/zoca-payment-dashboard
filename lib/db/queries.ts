/**
 * Postgres queries — one module so the rest of the app stays SQL-free.
 *
 * Flexible about env var naming: works whether the connection string is
 * exposed as POSTGRES_URL (legacy Vercel Postgres), DATABASE_URL (Neon
 * native), or STORAGE_URL / STORAGE_DATABASE_URL (Vercel Marketplace).
 */

// Surface the right connection string to @vercel/postgres BEFORE importing it.
// The library reads POSTGRES_URL at module load.
if (!process.env.POSTGRES_URL) {
  process.env.POSTGRES_URL =
    process.env.POSTGRES_PRISMA_URL ??
    process.env.DATABASE_URL ??
    process.env.STORAGE_DATABASE_URL ??
    process.env.STORAGE_URL ??
    process.env.DATABASE_POSTGRES_URL ??
    "";
}
if (!process.env.POSTGRES_URL_NON_POOLING) {
  process.env.POSTGRES_URL_NON_POOLING =
    process.env.DATABASE_URL_UNPOOLED ??
    process.env.STORAGE_DATABASE_URL_UNPOOLED ??
    process.env.POSTGRES_URL ??
    "";
}

import { sql } from "@vercel/postgres";

export type CustomerScope =
  | "discovery_first_pay"
  | "discovery_addon"
  | "other_subscription"
  | "no_subscription"
  | "pre_floor"
  | "pending";

export type CustomerStatus = "pending" | "processing" | "ready" | "failed" | "out_of_scope";

export type Customer = {
  cb_customer_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  biz_name: string | null;
  primary_category: string | null;
  locality: string | null;
  state_code: string | null;
  country: string | null;

  cb_created_at: string;
  cb_channel: string | null;
  cb_payment_method: string | null;

  stripe_customer_id: string | null;
  stripe_created_at: string | null;
  timestamp_mismatch_h: number | null;
  timestamp_mismatch_flag: boolean;

  sub_id: string | null;
  sub_status: string | null;
  sub_item_price_ids: string[] | null;
  sub_billing_period: number | null;
  sub_billing_period_unit: string | null;
  sub_total_cents: number | null;

  entity_id: string | null;
  ae_name: string | null;
  am_name: string | null;
  lead_source_group: string | null;
  lead_source: string | null;
  predicted_6_month_leads: number | null;
  open_tickets_30d: number | null;
  churn_potential_flag: string | null;
  total_monthly_revenue: number | null;

  total_reviews_at_onb: number | null;
  avg_rating_at_onb: number | null;
  five_star_reviews: number | null;

  booking_platform: string | null;
  booking_platform_url: string | null;
  booking_platform_active: boolean | null;

  scope: CustomerScope;
  verdict: "icp" | "review" | "not_icp" | null;
  needs_am_call: boolean;
  verdict_one_line: string | null;
  key_flags: string[] | null;

  report_blob_docx_url: string | null;
  report_blob_pdf_url: string | null;
  report_blob_json_url: string | null;
  report_blob_md_url: string | null;

  slack_channel_id: string | null;
  slack_ts: string | null;

  status: CustomerStatus;
  failure_reason: string | null;
  failure_attempts: number;

  created_at: string;
  updated_at: string;
};

export async function listCustomersSinceFloor(): Promise<Customer[]> {
  const floor = process.env.CUSTOMER_FLOOR_DATE ?? "2026-05-01";
  const { rows } = await sql<Customer>`
    SELECT * FROM customers
    WHERE cb_created_at >= ${floor}::timestamptz
    ORDER BY cb_created_at DESC
    LIMIT 1000
  `;
  return rows;
}

export async function getCustomer(cbCustomerId: string): Promise<Customer | null> {
  const { rows } = await sql<Customer>`
    SELECT * FROM customers WHERE cb_customer_id = ${cbCustomerId} LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function upsertCustomerStub(args: {
  cb_customer_id: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  biz_name?: string;
  cb_created_at: string;
  cb_channel?: string;
  cb_payment_method?: string;
}) {
  await sql`
    INSERT INTO customers (
      cb_customer_id, email, first_name, last_name, biz_name,
      cb_created_at, cb_channel, cb_payment_method, status, scope
    ) VALUES (
      ${args.cb_customer_id}, ${args.email ?? null}, ${args.first_name ?? null}, ${args.last_name ?? null}, ${args.biz_name ?? null},
      ${args.cb_created_at}, ${args.cb_channel ?? null}, ${args.cb_payment_method ?? null}, 'pending', 'pending'
    )
    ON CONFLICT (cb_customer_id) DO UPDATE
      SET email             = COALESCE(EXCLUDED.email, customers.email),
          first_name        = COALESCE(EXCLUDED.first_name, customers.first_name),
          last_name         = COALESCE(EXCLUDED.last_name, customers.last_name),
          biz_name          = COALESCE(EXCLUDED.biz_name, customers.biz_name),
          cb_channel        = COALESCE(EXCLUDED.cb_channel, customers.cb_channel),
          cb_payment_method = COALESCE(EXCLUDED.cb_payment_method, customers.cb_payment_method)
  `;
}

export async function setCustomerStatus(
  cbCustomerId: string,
  status: CustomerStatus,
  failureReason?: string,
) {
  await sql`
    UPDATE customers
    SET status = ${status},
        failure_reason = ${failureReason ?? null},
        failure_attempts = CASE WHEN ${status} = 'failed' THEN failure_attempts + 1 ELSE failure_attempts END
    WHERE cb_customer_id = ${cbCustomerId}
  `;
}

export async function logEvent(
  cbCustomerId: string,
  kind: string,
  detail?: Record<string, unknown>,
) {
  try {
    await sql`
      INSERT INTO events (cb_customer_id, kind, detail)
      VALUES (${cbCustomerId}, ${kind}, ${JSON.stringify(detail ?? {})}::jsonb)
    `;
  } catch (e: any) {
    // Events are best-effort audit; never let a failed insert block the pipeline.
    // Most common cause: FK violation when customer row doesn't exist yet.
    console.error(`[logEvent] failed for ${cbCustomerId}/${kind}:`, e?.message ?? e);
  }
}

/**
 * Heavy-handed update: sets every column from the validator/evaluator output
 * once a report is fully ready. Pass partial fields; nulls overwrite.
 */
export async function setCustomerReport(cbCustomerId: string, fields: Partial<Customer>) {
  // Build dynamic UPDATE — keep it explicit (no key allow-listing surprises)
  const allowed: (keyof Customer)[] = [
    "stripe_customer_id", "stripe_created_at", "timestamp_mismatch_h", "timestamp_mismatch_flag",
    "sub_id", "sub_status", "sub_item_price_ids", "sub_billing_period", "sub_billing_period_unit", "sub_total_cents",
    "entity_id", "ae_name", "am_name", "lead_source_group", "lead_source",
    "predicted_6_month_leads", "open_tickets_30d", "churn_potential_flag", "total_monthly_revenue",
    "total_reviews_at_onb", "avg_rating_at_onb", "five_star_reviews",
    "booking_platform", "booking_platform_url", "booking_platform_active",
    "primary_category", "locality", "state_code", "country",
    "scope", "verdict", "needs_am_call", "verdict_one_line", "key_flags",
    "report_blob_docx_url", "report_blob_pdf_url", "report_blob_json_url", "report_blob_md_url",
    "slack_channel_id", "slack_ts", "status", "failure_reason",
  ];
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  for (const k of allowed) {
    if (fields[k] === undefined) continue;
    sets.push(`${k} = $${i++}`);
    vals.push(fields[k]);
  }
  if (!sets.length) return;
  vals.push(cbCustomerId);
  const q = `UPDATE customers SET ${sets.join(", ")} WHERE cb_customer_id = $${i}`;
  await sql.query(q, vals);
}
