/**
 * Stage 1 of the analyze pipeline — validator + small enrichment.
 *
 * Pipeline (3 stages, each <60s to fit Vercel Hobby cap):
 *   Stage 1 — /api/analyze/[id]        — CB + Stripe + BaseSheet + 3 small CSVs → DB
 *   Stage 2 — /api/analyze/[id]/comms   — 5 comms CSVs (parallel)               → Blob
 *   Stage 3 — /api/analyze/[id]/llm     — Anthropic + docx + Slack              → DB
 *
 * Each stage fires off the next via fire-and-forget POST after returning 200.
 * Stage URLs use the same /api/analyze/[id] prefix so they share routing context.
 */

import { NextRequest, NextResponse } from "next/server";
import { buildBundleLight } from "@/lib/validator/bundle";
import { saveStageBundle } from "@/lib/stage-store";
import {
  setCustomerReport, setCustomerStatus, logEvent, upsertCustomerStub,
} from "@/lib/db/queries";

export const runtime = "nodejs";
export const maxDuration = 60;
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
  return "discovery_first_pay";
}

async function fireAndForget(url: string, body: unknown) {
  // Trigger next stage. We await the call briefly so the connection establishes,
  // but the response body is not awaited — the next stage executes independently.
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      // Don't wait for the full response. Next stage runs on its own.
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Expected — the AbortSignal will timeout shortly after the connection is established.
    // The next stage has been triggered; we just don't wait for it.
  }
}

export async function POST(req: NextRequest, ctx: { params: { customer_id: string } }) {
  const customerId = ctx.params.customer_id;
  if (!customerId) return NextResponse.json({ ok: false, error: "missing_customer_id" }, { status: 400 });

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${req.headers.get("host")}`;

  // --- Stage 1: build the light bundle (no comms) -------------------------
  let bundle;
  try {
    bundle = await buildBundleLight(customerId);
  } catch (e: any) {
    return NextResponse.json({ ok: false, stage: "stage1_validator", error: e.message }, { status: 500 });
  }

  // Upsert customer row so subsequent calls have a valid FK target
  const cbCustomer = bundle.chargebee_customer ?? {};
  await upsertCustomerStub({
    cb_customer_id: customerId,
    email: cbCustomer.email ?? undefined,
    first_name: cbCustomer.first_name ?? undefined,
    last_name: cbCustomer.last_name ?? undefined,
    biz_name: cbCustomer.cf_entity_name ?? cbCustomer.company ?? undefined,
    cb_created_at: new Date(bundle.t_chargebee_unix * 1000).toISOString(),
    cb_channel: cbCustomer.channel ?? undefined,
    cb_payment_method: cbCustomer.payment_method?.type ?? undefined,
  });
  await logEvent(customerId, "stage1_started", {});

  const scope = deriveScope(bundle);

  // Out-of-scope: stop here, no further stages
  if (scope !== "discovery_first_pay") {
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

  // In-scope: persist everything from stage 1 and save bundle to Blob
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
    status: "processing",
  });

  // Save bundle so Stage 2 can read it instead of re-fetching all the enrichment
  const bundleUrl = await saveStageBundle(customerId, bundle);
  await logEvent(customerId, "stage1_done", { bundle_url: bundleUrl });

  // Fire-and-forget Stage 2
  await fireAndForget(`${baseUrl}/api/analyze/${customerId}/comms`, { bundle_url: bundleUrl });

  return NextResponse.json({ ok: true, status: "stage1_done", next: "comms" });
}
