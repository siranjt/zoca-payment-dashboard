/**
 * Dashboard home — server shell that fetches customers and hydrates the
 * client-side DashboardClient (which owns all filter/search/sort state).
 */

import { listCustomersSinceFloor, type Customer } from "@/lib/db/queries";
import DashboardClient from "@/components/DashboardClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page() {
  let customers: Customer[] = [];
  let dbError: string | null = null;
  try {
    customers = await listCustomersSinceFloor();
  } catch (e: any) {
    dbError = e.message;
  }

  if (dbError) {
    return (
      <div className="rounded-2xl border border-accent-red/40 bg-accent-red-bg/40 px-5 py-4 text-sm text-accent-red mt-8">
        <strong className="text-ink">Database connection error:</strong> {dbError}
        <div className="text-xs text-ink-dim mt-2">
          Run <code className="font-mono">npm run db:migrate</code> to create the schema, and check <code className="font-mono">POSTGRES_URL</code> in env.
        </div>
      </div>
    );
  }

  // Cast to the trimmer shape the client expects (DB type has extra fields).
  // CRITICAL: cb_created_at comes from Neon as a JS Date. Coerce to ISO
  // string here — once it crosses the server→client RSC boundary, calling
  // string methods on a Date throws and triggers a client-side exception.
  const toIso = (v: unknown): string => {
    if (!v) return "";
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "string") return v;
    try { return new Date(v as any).toISOString(); } catch { return ""; }
  };

  const payload = customers.map((c) => ({
    cb_customer_id: c.cb_customer_id,
    biz_name: c.biz_name,
    email: c.email,
    am_name: c.am_name,
    ae_name: c.ae_name,
    scope: c.scope,
    verdict: c.verdict,
    status: c.status,
    failure_reason: c.failure_reason,
    cb_created_at: toIso(c.cb_created_at),
    primary_category: c.primary_category,
    predicted_6_month_leads: c.predicted_6_month_leads,
  }));

  return <DashboardClient customers={payload} />;
}
