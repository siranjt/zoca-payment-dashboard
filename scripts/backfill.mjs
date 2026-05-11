#!/usr/bin/env node
/**
 * Backfill — pull every Chargebee customer created on/after CUSTOMER_FLOOR_DATE
 * and POST /api/analyze/<id> for each. Use this once after first deploy to catch
 * customers created before the webhook was wired up.
 *
 * Usage:
 *   node scripts/backfill.mjs
 *   APP_URL=https://your-app.vercel.app node scripts/backfill.mjs
 */
import "dotenv/config";

const APP_URL = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL;
const FLOOR = process.env.CUSTOMER_FLOOR_DATE ?? "2026-05-01";
const CB_KEY = process.env.CHARGEBEE_API_KEY;
const CB_SITE = process.env.CHARGEBEE_SITE ?? "zoca";

if (!APP_URL || !CB_KEY) {
  console.error("Set APP_URL and CHARGEBEE_API_KEY first");
  process.exit(1);
}

const floorUnix = Math.floor(new Date(`${FLOOR}T00:00:00Z`).getTime() / 1000);
const auth = "Basic " + Buffer.from(CB_KEY + ":").toString("base64");

async function listCustomers() {
  const out = [];
  let offset = null;
  do {
    const url = new URL(`https://${CB_SITE}.chargebee.com/api/v2/customers`);
    url.searchParams.set("limit", "100");
    url.searchParams.set("created_at[after]", String(floorUnix));
    url.searchParams.set("sort_by[asc]", "created_at");
    if (offset) url.searchParams.set("offset", offset);
    const res = await fetch(url, { headers: { authorization: auth } });
    const data = await res.json();
    for (const e of data.list ?? []) out.push(e.customer);
    offset = data.next_offset ?? null;
  } while (offset);
  return out;
}

const customers = await listCustomers();
console.log(`Found ${customers.length} customers since ${FLOOR}`);
for (const c of customers) {
  process.stdout.write(`  ${c.id} (${c.email ?? "no email"}) ... `);
  try {
    const res = await fetch(`${APP_URL}/api/analyze/${c.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const data = await res.json();
    console.log(data.ok ? `${data.status ?? "ok"}` : `failed (${data.error})`);
  } catch (e) {
    console.log("error:", e.message);
  }
}
