/**
 * /api/analyze/[customer_id] — full pipeline orchestrator.
 *
 * Called by:
 *   - /api/cb-webhook (fire-and-forget) when subscription_created fires for a Discovery sub
 *   - Manual backfill scripts
 *   - Internal admin retry from the dashboard UI
 *
 * Steps:
 *   1. validator.buildBundle(customer_id)
 *   2. evaluator.evaluate(bundle)        [retries once on JSON-parse fail]
 *   3. render.renderAndUpload()          [docx + JSON + Markdown to Vercel Blob]
 *   4. db.setCustomerReport()            [scope, verdict, blob URLs, status=ready]
 *   5. slack.postCustomerReport()        [verdict + flags + dashboard link + .docx upload]
 *
 * On any step's failure:
 *   - log to events table
 *   - mark status=failed with reason
 *   - if step 2 failed both retries: fall back to Markdown-only Slack post
 */

import { NextRequest, NextResponse } from "next/server";
import { buildBundle } from "@/lib/validator/bundle";
import { evaluate } from "@/lib/evaluator/anthropic";
import { renderAndUpload } from "@/lib/render/render";
import { postCustomerReport } from "@/lib/slack";
import { setCustomerReport, setCustomerStatus, logEvent, getCustomer } from "@/lib/db/queries";

export const runtime = "nodejs";
export const maxDuration = 300; // 5 minutes — comms-CSV downloads + LLM call can take a while
export const dynamic = "force-dynamic";

function pickEntityFields(b: any) {
  const e = (b.entities ?? [])[0] ?? {};
  return {
    entity_id: e.entity_id ?? null,
    biz_name: e.bizname ?? null,
    primary_category: e.primary_category ?? null,
    locality: e.locality ?? null,
    state_code: e.state ?? null,
    country: e.country ?? null,
    ae_name: e.ae_name ?? null,
    am_name: e.am_name ?? null,
    lead_source_group: e.lead_source_group ?? null,
    lead_source: e.lead_source ?? null,
    open_tickets_30d: e.open_tickets_last_30_days ? Number(e.open_tickets_last_30_days) : null,
    churn_potential_flag: e.churn_potential_flag ?? null,
    total_monthly_revenue: e.total_monthly_revenue ? Number(e.total_monthly_revenue) : null,
  };
}

function pickReviewFields(rm: any) {
  if (!rm) return { total_reviews_at_onb: null, avg_rating_at_onb: null, five_star_reviews: null, predicted_6_month_leads: null };
  return {
    total_reviews_at_onb: rm.total_reviews_at_onboarding ? Number(rm.total_reviews_at_onboarding) : null,
    avg_rating_at_onb: rm.avg_rating_at_onboarding ? Number(rm.avg_rating_at_onboarding) : null,
    five_star_reviews: rm.five_star_reviews ? Number(rm.five_star_reviews) : null,
    predicted_6_month_leads: rm.predicted_6_month_leads ? Number(rm.predicted_6_month_leads) : null,
  };
}

function pickBookingFields(rows: any[]) {
  const bp = (rows ?? []).find(r => r["Platform Type"] === "BOOKING_PLATFORM" && r["Is Active"] === "true");
  return {
    booking_platform: bp?.["Platform Name"] ?? null,
    booking_platform_url: bp?.["Link"] ?? null,
    booking_platform_active: bp ? true : null,
  };
}

function deriveScope(b: any): "discovery_first_pay" | "discovery_addon" | "no_subscription" | "pre_floor" | "other_subscription" {
  if (b.pre_floor) return "pre_floor";
  if (!b.subscription) return "no_subscription";
  if (!b.discovery_match) return "other_subscription";
  return "discovery_first_pay"; // first sub IS Discovery
}

export async function POST(_req: NextRequest, ctx: { params: { customer_id: string } }) {
  const customerId = ctx.params.customer_id;
  if (!customerId) return NextResponse.json({ ok: false, error: "missing_customer_id" }, { status: 400 });

  await logEvent(customerId, "analyze_started", {});

  // --- Step 1: build bundle ------------------------------------------------
  let bundle;
  try {
    bundle = await buildBundle(customerId);
    await logEvent(customerId, "validator_done", { skip_reason: bundle.skip_reason, comms: bundle.comms_summary });
  } catch (e: any) {
    await setCustomerStatus(customerId, "failed", `validator: ${e.message}`);
    await logEvent(customerId, "failure", { stage: "validator", error: e.message });
    return NextResponse.json({ ok: false, stage: "validator", error: e.message }, { status: 500 });
  }

  const scope = deriveScope(bundle);
  if (scope !== "discovery_first_pay") {
    // Out of scope — stamp the row and exit. No LLM call, no docx, no Slack.
    await setCustomerReport(customerId, {
      scope,
      stripe_customer_id: bundle.stripe_customer?.id ?? null,
      stripe_created_at: bundle.t_stripe_unix ? new Date(bundle.t_stripe_unix * 1000).toISOString() : null,
      timestamp_mismatch_h: bundle.timestamp_mismatch_hours,
      timestamp_mismatch_flag: bundle.timestamp_mismatch_flag,
      sub_id: bundle.subscription?.id ?? null,
      sub_status: bundle.subscription?.status ?? null,
      sub_item_price_ids: (bundle.subscription?.subscription_items ?? []).map((i: any) => i.item_price_id),
      ...pickEntityFields(bundle),
      ...pickReviewFields(bundle.review_metrics),
      ...pickBookingFields(bundle.booking_platform_rows),
      status: "out_of_scope",
      failure_reason: bundle.skip_reason,
    });
    await logEvent(customerId, "out_of_scope", { reason: bundle.skip_reason });
    return NextResponse.json({ ok: true, status: "out_of_scope", reason: bundle.skip_reason });
  }

  // --- Step 2: LLM evaluation ---------------------------------------------
  let evalResult;
  try {
    evalResult = await evaluate({ bundle });
    await logEvent(customerId, "llm_eval_done", { markdown_chars: evalResult.markdown.length });
  } catch (e: any) {
    // Fallback: post Markdown-only summary if available, mark report failed.
    await setCustomerStatus(customerId, "failed", `evaluator: ${e.message}`);
    await logEvent(customerId, "failure", { stage: "evaluator", error: e.message });
    return NextResponse.json({ ok: false, stage: "evaluator", error: e.message }, { status: 500 });
  }

  // --- Step 3: render docx + upload to blob -------------------------------
  let render;
  try {
    render = await renderAndUpload({ cbCustomerId: customerId, reportData: evalResult.reportData, markdown: evalResult.markdown });
    await logEvent(customerId, "docx_rendered", { bytes: render.bytes });
  } catch (e: any) {
    // Don't hard-fail — we can still post Markdown to Slack
    console.error("[analyze] render failed:", e.message);
    render = null;
    await logEvent(customerId, "render_failed", { error: e.message });
  }

  // --- Step 4: persist to DB ----------------------------------------------
  const verdict = evalResult.reportData?.exec?.verdict_label?.toLowerCase()?.replace(/\s+/g, "_") ?? null;
  const verdictNorm: "icp" | "review" | "not_icp" | null =
    verdict === "icp" ? "icp"
    : verdict === "review" ? "review"
    : verdict === "not_icp" ? "not_icp"
    : null;
  const keyFlags: string[] = (evalResult.reportData?.exec?.reinforcing_flags
    ? [evalResult.reportData.exec.reinforcing_flags]
    : []) as string[];

  await setCustomerReport(customerId, {
    scope,
    stripe_customer_id: bundle.stripe_customer?.id ?? null,
    stripe_created_at: bundle.t_stripe_unix ? new Date(bundle.t_stripe_unix * 1000).toISOString() : null,
    timestamp_mismatch_h: bundle.timestamp_mismatch_hours,
    timestamp_mismatch_flag: bundle.timestamp_mismatch_flag,
    sub_id: bundle.subscription?.id ?? null,
    sub_status: bundle.subscription?.status ?? null,
    sub_item_price_ids: (bundle.subscription?.subscription_items ?? []).map((i: any) => i.item_price_id),
    sub_billing_period: bundle.subscription?.billing_period ?? null,
    sub_billing_period_unit: bundle.subscription?.billing_period_unit ?? null,
    sub_total_cents: bundle.invoices?.[0]?.total ?? null,
    ...pickEntityFields(bundle),
    ...pickReviewFields(bundle.review_metrics),
    ...pickBookingFields(bundle.booking_platform_rows),
    verdict: verdictNorm,
    needs_am_call: !!evalResult.reportData?.exec?.recommended_action_label?.toLowerCase()?.includes("am"),
    verdict_one_line: evalResult.reportData?.exec?.driver ?? null,
    key_flags: keyFlags,
    report_blob_docx_url: render?.docxUrl ?? null,
    report_blob_json_url: render?.jsonUrl ?? null,
    report_blob_md_url: render?.mdUrl ?? null,
    status: "ready",
    failure_reason: null,
  });

  // --- Step 5: Slack post -------------------------------------------------
  try {
    const cust = await getCustomer(customerId);
    const slackRes = await postCustomerReport({
      cbCustomerId: customerId,
      bizName: cust?.biz_name ?? null,
      amName: cust?.am_name ?? null,
      verdict: verdictNorm,
      needsAmCall: !!cust?.needs_am_call,
      oneLine: cust?.verdict_one_line ?? null,
      keyFlags,
      markdown: evalResult.markdown,
      docxBlobUrl: render?.docxUrl ?? null,
    });
    if (slackRes.ts) {
      await setCustomerReport(customerId, {
        slack_channel_id: process.env.SLACK_CHANNEL_ID ?? null,
        slack_ts: slackRes.ts,
      });
    }
    await logEvent(customerId, "slack_posted", { ts: slackRes.ts ?? null, posted: slackRes.posted, file_url: slackRes.fileUrl });
  } catch (e: any) {
    console.error("[analyze] slack post failed:", e.message);
    await logEvent(customerId, "slack_failed", { error: e.message });
  }

  return NextResponse.json({ ok: true, status: "ready" });
}
