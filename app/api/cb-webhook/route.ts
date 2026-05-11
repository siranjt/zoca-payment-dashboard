/**
 * Chargebee webhook receiver.
 *
 * Configure in Chargebee → Settings → Webhooks:
 *   URL:    https://<your-vercel-app>/api/cb-webhook
 *   Events: customer_created, subscription_created, subscription_activated
 *   Auth:   Basic Auth (use any username; password = CHARGEBEE_WEBHOOK_SECRET)
 *
 * On customer_created:
 *   - Insert a stub row in `customers` with status=pending, scope=pending.
 *
 * On subscription_created/activated:
 *   - If the customer's first sub is on Discovery, fire-and-forget POST to
 *     /api/analyze/<customer_id> which runs the full pipeline.
 *   - If not Discovery, mark scope as 'other_subscription' and status as 'out_of_scope'.
 *
 * Returns 200 immediately — Chargebee retries on timeout/non-2xx, so we MUST
 * acknowledge fast and do heavy work asynchronously.
 */

import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { upsertCustomerStub, setCustomerStatus, logEvent, getCustomer } from "@/lib/db/queries";

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
    // Format is "username:password" — we only check the password
    const password = decoded.split(":").slice(1).join(":");
    return password === expected;
  } catch {
    return false;
  }
}

function fireAndForget(url: string, body: unknown) {
  // Use Vercel's `waitUntil()` — without it, in-flight fetches get killed when
  // the webhook function returns 200 to Chargebee. The fetch promise must
  // remain "alive" until completion, OR we have to explicitly tell Vercel to
  // keep the function alive for it via waitUntil.
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
    case "customer_created": {
      const customer = content.customer;
      if (!customer?.id || !customer?.created_at) {
        return NextResponse.json({ ok: false, error: "missing_customer" }, { status: 400 });
      }
      const cbCreatedAt = new Date(customer.created_at * 1000);
      const floor = new Date(`${FLOOR_DATE}T00:00:00Z`);
      const beforeFloor = cbCreatedAt < floor;

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

      if (beforeFloor) {
        await setCustomerStatus(customer.id, "out_of_scope", `customer_created_before_floor (${cbCreatedAt.toISOString()} < ${FLOOR_DATE})`);
        await logEvent(customer.id, "skipped_pre_floor", { cb_created_at: cbCreatedAt.toISOString(), floor: FLOOR_DATE });
      } else {
        await logEvent(customer.id, "webhook_received", { event_type: eventType, cb_created_at: cbCreatedAt.toISOString() });
      }

      return NextResponse.json({ ok: true });
    }

    case "subscription_created":
    case "subscription_activated": {
      const sub = content.subscription;
      const customer = content.customer;
      if (!sub?.id || !sub?.customer_id) {
        return NextResponse.json({ ok: false, error: "missing_subscription" }, { status: 400 });
      }

      // If we don't yet have the customer row (race with customer_created), insert a stub
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

      // Detect Discovery
      const itemPriceIds: string[] = (sub.subscription_items ?? []).map((i: any) => i.item_price_id);
      const isDiscovery = itemPriceIds.some(p => p && p.toLowerCase().includes(DISCOVERY_PATTERN));

      // Determine if this sub is the customer's first-ever — query Chargebee for confirmation.
      // For the webhook's hot-path we trust the event but flag it; the /api/analyze pipeline
      // verifies first-ever and stamps scope correctly.
      await logEvent(sub.customer_id, "webhook_received", {
        event_type: eventType, sub_id: sub.id, item_price_ids: itemPriceIds, is_discovery: isDiscovery,
      });

      if (isDiscovery) {
        await setCustomerStatus(sub.customer_id, "processing");
        // Kick off the full analysis pipeline asynchronously
        fireAndForget(`${baseUrl}/api/analyze/${sub.customer_id}`, { trigger: "cb_webhook", event_type: eventType });
      } else {
        // Out of scope (different SKU). Stamp scope but leave status as out_of_scope.
        await setCustomerStatus(sub.customer_id, "out_of_scope", "non-discovery subscription");
      }

      return NextResponse.json({ ok: true, is_discovery: isDiscovery });
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
    expected_events: ["customer_created", "subscription_created", "subscription_activated"],
  });
}
