/**
 * Chargebee webhook receiver.
 *
 * Configure in Chargebee → Settings → Webhooks:
 *   URL:    https://<your-vercel-app>/api/cb-webhook
 *   Events: customer_created, subscription_created, subscription_activated, payment_succeeded
 *   Auth:   Basic Auth (use any username; password = CHARGEBEE_WEBHOOK_SECRET)
 *
 * TRIGGER LOGIC (the only path that fires analysis):
 *   payment_succeeded
 *     AND invoice is the customer's FIRST-EVER invoice on their FIRST-EVER subscription
 *     AND that subscription is Discovery
 *     AND customer's Chargebee created_at >= CUSTOMER_FLOOR_DATE
 *
 * Everything else is bookkeeping:
 *   • customer_created — insert a stub row so the customer is tracked
 *   • subscription_created / subscription_activated — log the event;
 *     analysis fires later when payment_succeeded arrives for the first invoice
 *
 * Returns 200 immediately — Chargebee retries on timeout/non-2xx, so we MUST
 * acknowledge fast and do heavy work asynchronously via waitUntil().
 */

import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { upsertCustomerStub, setCustomerStatus, logEvent, getCustomer } from "@/lib/db/queries";
import {
  listSubscriptionsForCustomer as cbListSubs,
  listInvoicesForSubscription as cbListInvoices,
} from "@/lib/validator/chargebee";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FLOOR_DATE = process.env.CUSTOMER_FLOOR_DATE ?? "2026-05-01";
const DISCOVERY_PATTERN = (process.env.DISCOVERY_FILTER_PATTERN ?? "discovery").toLowerCase();

function unauthorized(reason: string) {
  return NextResponse.json({ ok: false, error: "unauthorized", reason }, { status: 401 });
}

function verifyBasicAuth(req: NextRequest): boolean {
  const expected = process.env.CHARGEBEE_WEBHOOK_SECRET;
  if (!expected) return true; // dev mode: no secret configured
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const password = decoded.split(":").slice(1).join(":");
    return password === expected;
  } catch {
    return false;
  }
}

function fireAndForget(url: string, body: unknown) {
  // waitUntil keeps the in-flight fetch alive after we return 200 to Chargebee.
  const work = (async () => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      console.log(`[webhook→analyze] POST ${url} status=${res.status}`);
    } catch (err: any) {
      console.error(`[webhook→analyze] POST ${url} failed:`, err?.message ?? err);
    }
  })();
  waitUntil(work);
}

function beforeFloor(cbCreatedAtSeconds: number | undefined | null): boolean {
  if (!cbCreatedAtSeconds) return false;
  const created = new Date(cbCreatedAtSeconds * 1000);
  const floor = new Date(`${FLOOR_DATE}T00:00:00Z`);
  return created < floor;
}

export async function POST(req: NextRequest) {
  if (!verifyBasicAuth(req)) return unauthorized("bad auth");

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  const eventType = payload?.event_type as string | undefined;
  const content = payload?.content;
  if (!eventType || !content) {
    return NextResponse.json({ ok: false, error: "missing_event_type_or_content" }, { status: 400 });
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${req.headers.get("host")}`;

  switch (eventType) {
    /* ──────────────────────────────────────────────
       customer_created — STUB ONLY, no analysis
       ────────────────────────────────────────────── */
    case "customer_created": {
      const customer = content.customer;
      if (!customer?.id || !customer?.created_at) {
        return NextResponse.json({ ok: false, error: "missing_customer" }, { status: 400 });
      }
      const cbCreatedAt = new Date(customer.created_at * 1000);

      await upsertCustomerStub({
        cb_customer_id: customer.id,
        email: customer.email ?? null,
        first_name: customer.first_name ?? null,
        last_name: customer.last_name ?? null,
        biz_name: customer.cf_entity_name ?? customer.company ?? null,
        cb_created_at: cbCreatedAt.toISOString(),
        cb_channel: customer.channel ?? null,
        cb_payment_method: customer.payment_method?.type ?? null,
      });

      if (beforeFloor(customer.created_at)) {
        await setCustomerStatus(customer.id, "out_of_scope", `customer_created_before_floor (${cbCreatedAt.toISOString()} < ${FLOOR_DATE})`);
        await logEvent(customer.id, "skipped_pre_floor", { cb_created_at: cbCreatedAt.toISOString(), floor: FLOOR_DATE });
      } else {
        await logEvent(customer.id, "webhook_received", { event_type: eventType, cb_created_at: cbCreatedAt.toISOString() });
      }

      return NextResponse.json({ ok: true, action: "stub_inserted" });
    }

    /* ──────────────────────────────────────────────
       subscription_created / subscription_activated
       — bookkeeping only. Analysis fires later when
         payment_succeeded arrives for the first invoice.
       ────────────────────────────────────────────── */
    case "subscription_created":
    case "subscription_activated": {
      const sub = content.subscription;
      const customer = content.customer;
      if (!sub?.id || !sub?.customer_id) {
        return NextResponse.json({ ok: false, error: "missing_subscription" }, { status: 400 });
      }

      // Insert stub if we don't have the customer yet (race with customer_created)
      const existing = await getCustomer(sub.customer_id);
      if (!existing && customer) {
        await upsertCustomerStub({
          cb_customer_id: sub.customer_id,
          email: customer.email ?? null,
          first_name: customer.first_name ?? null,
          last_name: customer.last_name ?? null,
          biz_name: customer.cf_entity_name ?? customer.company ?? null,
          cb_created_at: customer.created_at ? new Date(customer.created_at * 1000).toISOString() : new Date().toISOString(),
          cb_channel: customer.channel ?? null,
          cb_payment_method: customer.payment_method?.type ?? null,
        });
      }

      const itemPriceIds: string[] = (sub.subscription_items ?? []).map((i: any) => i.item_price_id);
      await logEvent(sub.customer_id, "webhook_received", {
        event_type: eventType,
        sub_id: sub.id,
        item_price_ids: itemPriceIds,
        note: "awaiting payment_succeeded for first invoice",
      });

      return NextResponse.json({ ok: true, action: "logged_awaiting_payment" });
    }

    /* ──────────────────────────────────────────────
       payment_succeeded — THE TRIGGER
       Fires analysis only when ALL gates pass.
       ────────────────────────────────────────────── */
    case "payment_succeeded": {
      const invoice = content.invoice;
      const customer = content.customer;
      if (!invoice?.id || !invoice?.customer_id) {
        return NextResponse.json({ ok: false, error: "missing_invoice_on_payment_succeeded" }, { status: 400 });
      }
      const customerId: string = invoice.customer_id;

      // Insert stub if missing (defensive — should already exist from customer_created)
      const existing = await getCustomer(customerId);
      if (!existing && customer) {
        await upsertCustomerStub({
          cb_customer_id: customerId,
          email: customer.email ?? null,
          first_name: customer.first_name ?? null,
          last_name: customer.last_name ?? null,
          biz_name: customer.cf_entity_name ?? customer.company ?? null,
          cb_created_at: customer.created_at ? new Date(customer.created_at * 1000).toISOString() : new Date().toISOString(),
          cb_channel: customer.channel ?? null,
          cb_payment_method: customer.payment_method?.type ?? null,
        });
      }

      // ──────────────────────────────────────────────
      // GATE 0 — Floor date
      // ──────────────────────────────────────────────
      const cbCreatedAt = customer?.created_at ?? null;
      if (beforeFloor(cbCreatedAt)) {
        await setCustomerStatus(customerId, "out_of_scope", `customer_created_before_floor`);
        await logEvent(customerId, "skipped_pre_floor", { cb_created_at: cbCreatedAt, floor: FLOOR_DATE });
        return NextResponse.json({ ok: true, skipped: "pre_floor" });
      }

      // ──────────────────────────────────────────────
      // GATE 1 — Customer has exactly ONE subscription (first-ever, only)
      // ──────────────────────────────────────────────
      let allSubs: any[] = [];
      try {
        allSubs = await cbListSubs(customerId);
      } catch (e: any) {
        // If we can't reach Chargebee, log and bail rather than fire a half-validated analysis
        await logEvent(customerId, "payment_succeeded_chargebee_lookup_failed", { error: e?.message ?? String(e) });
        return NextResponse.json({ ok: false, error: "chargebee_lookup_failed" }, { status: 502 });
      }

      if (allSubs.length !== 1) {
        await setCustomerStatus(customerId, "out_of_scope", `not_first_ever_sub (count=${allSubs.length})`);
        await logEvent(customerId, "skipped_not_first_ever_sub", {
          invoice_id: invoice.id,
          sub_count: allSubs.length,
          sub_ids: allSubs.map((s: any) => s.id),
        });
        return NextResponse.json({ ok: true, skipped: "not_first_ever_sub", sub_count: allSubs.length });
      }
      const firstSub = allSubs[0];

      // ──────────────────────────────────────────────
      // GATE 2 — That subscription is Discovery
      // ──────────────────────────────────────────────
      const itemPriceIds: string[] = (firstSub.subscription_items ?? []).map((i: any) => i.item_price_id ?? "");
      const isDiscovery = itemPriceIds.some((p: string) => p && p.toLowerCase().includes(DISCOVERY_PATTERN));
      if (!isDiscovery) {
        await setCustomerStatus(customerId, "out_of_scope", "non_discovery_subscription");
        await logEvent(customerId, "skipped_non_discovery", {
          invoice_id: invoice.id,
          item_price_ids: itemPriceIds,
        });
        return NextResponse.json({ ok: true, skipped: "non_discovery" });
      }

      // ──────────────────────────────────────────────
      // GATE 3 — This invoice is the FIRST invoice for the subscription
      // ──────────────────────────────────────────────
      let allInvoices: any[] = [];
      try {
        allInvoices = await cbListInvoices(firstSub.id);
      } catch (e: any) {
        await logEvent(customerId, "payment_succeeded_invoice_lookup_failed", { error: e?.message ?? String(e) });
        return NextResponse.json({ ok: false, error: "invoice_lookup_failed" }, { status: 502 });
      }
      const sortedByDate = [...allInvoices].sort((a, b) => (a.date ?? 0) - (b.date ?? 0));
      const firstInvoiceId = sortedByDate[0]?.id;
      if (firstInvoiceId !== invoice.id) {
        // This is a renewal payment, not the first one. Don't mark out_of_scope — the
        // customer is still legitimately on Discovery; we just don't re-analyse.
        await logEvent(customerId, "skipped_renewal_payment", {
          invoice_id: invoice.id,
          first_invoice_id: firstInvoiceId,
          sub_id: firstSub.id,
        });
        return NextResponse.json({ ok: true, skipped: "renewal_payment" });
      }

      // ──────────────────────────────────────────────
      // ALL GATES PASSED — fire analysis
      // ──────────────────────────────────────────────
      await logEvent(customerId, "payment_succeeded_first_invoice", {
        invoice_id: invoice.id,
        sub_id: firstSub.id,
        item_price_ids: itemPriceIds,
        amount_paid: invoice.amount_paid,
        currency: invoice.currency_code,
      });
      await setCustomerStatus(customerId, "processing");
      fireAndForget(`${baseUrl}/api/analyze/${customerId}`, {
        trigger: "cb_webhook_payment_succeeded",
        event_type: eventType,
        invoice_id: invoice.id,
        sub_id: firstSub.id,
      });

      return NextResponse.json({ ok: true, fired: true, invoice_id: invoice.id, sub_id: firstSub.id });
    }

    default:
      // Unhandled events are still 200 — Chargebee retries on non-2xx, and we'd rather
      // log and ignore than retry-storm.
      return NextResponse.json({ ok: true, ignored: eventType });
  }
}

export async function GET() {
  return NextResponse.json({
    name: "zoca-payment-dashboard cb-webhook",
    status: "alive",
    expected_method: "POST",
    expected_events: [
      "customer_created",
      "subscription_created",
      "subscription_activated",
      "payment_succeeded",
    ],
    trigger_logic:
      "Analysis fires ONLY on payment_succeeded for the customer's first-ever invoice on their first-ever (and only) Discovery subscription, post-floor.",
  });
}
