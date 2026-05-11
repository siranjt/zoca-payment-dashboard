/**
 * Dashboard home — list of all Chargebee customers since the floor date.
 *
 * Default sort: cb_created_at DESC.
 * Filter chips: scope, verdict.
 * Click "Open report" → /reports/<cb_customer_id>.
 */

import { listCustomersSinceFloor, type Customer } from "@/lib/db/queries";
import Link from "next/link";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function VerdictPill({ c }: { c: Customer }) {
  if (c.status === "pending" || c.status === "processing") {
    return <span className="text-zoca-gap text-sm">⏳ {c.status}</span>;
  }
  if (c.status === "failed") {
    return <span className="text-zoca-fail text-sm" title={c.failure_reason ?? ""}>⚠️ failed</span>;
  }
  if (c.scope !== "discovery_first_pay") {
    const reason = c.scope === "no_subscription" ? "no sub yet"
      : c.scope === "other_subscription" ? "non-Discovery"
      : c.scope === "discovery_addon" ? "Discovery add-on"
      : c.scope === "pre_floor" ? "pre-floor" : c.scope;
    return <span className="text-zoca-gap text-sm">— {reason}</span>;
  }
  if (c.verdict === "icp") return <span className="text-zoca-pass font-medium">✅ ICP</span>;
  if (c.verdict === "review") return <span className="text-zoca-warn font-medium">⚠️ Review</span>;
  if (c.verdict === "not_icp") return <span className="text-zoca-fail font-medium">❌ Not ICP</span>;
  return <span className="text-zoca-gap text-sm">—</span>;
}

function ScopeChip({ scope }: { scope: Customer["scope"] }) {
  const map: Record<Customer["scope"], { label: string; cls: string }> = {
    discovery_first_pay:  { label: "Discovery first-pay",  cls: "bg-blue-100 text-blue-800" },
    discovery_addon:      { label: "Discovery add-on",     cls: "bg-blue-50 text-blue-700" },
    other_subscription:   { label: "Non-Discovery sub",    cls: "bg-slate-100 text-slate-700" },
    no_subscription:      { label: "No sub yet",           cls: "bg-slate-100 text-slate-600" },
    pre_floor:            { label: "Pre-floor",            cls: "bg-amber-50 text-amber-700" },
    pending:              { label: "Pending",              cls: "bg-slate-100 text-slate-500" },
  };
  const v = map[scope] ?? { label: scope, cls: "bg-slate-100 text-slate-700" };
  return <span className={`inline-block text-xs px-2 py-0.5 rounded font-medium ${v.cls}`}>{v.label}</span>;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toISOString().slice(0, 16).replace("T", " ") + "Z";
}

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
      <div className="bg-red-50 border border-red-200 rounded-lg p-6">
        <h2 className="font-bold text-zoca-fail">Database connection error</h2>
        <p className="text-sm text-red-700 mt-2">{dbError}</p>
        <p className="text-xs text-slate-500 mt-4">Run <code>npm run db:migrate</code> to create the schema, and check <code>POSTGRES_URL</code> in your env.</p>
      </div>
    );
  }

  const totals = {
    all: customers.length,
    icp: customers.filter(c => c.verdict === "icp").length,
    review: customers.filter(c => c.verdict === "review").length,
    not_icp: customers.filter(c => c.verdict === "not_icp").length,
    out_of_scope: customers.filter(c => c.status === "out_of_scope").length,
    pending: customers.filter(c => c.status === "pending" || c.status === "processing").length,
    failed: customers.filter(c => c.status === "failed").length,
  };

  return (
    <div>
      {/* Stat strip */}
      <div className="grid grid-cols-3 sm:grid-cols-7 gap-2 mb-6">
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="text-xs text-slate-500">Total since floor</div>
          <div className="text-2xl font-bold text-zoca-ink">{totals.all}</div>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="text-xs text-slate-500">✅ ICP</div>
          <div className="text-2xl font-bold text-zoca-pass">{totals.icp}</div>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="text-xs text-slate-500">⚠️ Review</div>
          <div className="text-2xl font-bold text-zoca-warn">{totals.review}</div>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="text-xs text-slate-500">❌ Not ICP</div>
          <div className="text-2xl font-bold text-zoca-fail">{totals.not_icp}</div>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="text-xs text-slate-500">Out of scope</div>
          <div className="text-2xl font-bold text-zoca-gap">{totals.out_of_scope}</div>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="text-xs text-slate-500">Pending</div>
          <div className="text-2xl font-bold text-slate-500">{totals.pending}</div>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="text-xs text-slate-500">Failed</div>
          <div className="text-2xl font-bold text-zoca-fail">{totals.failed}</div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-100 text-slate-600 uppercase tracking-wide text-xs">
            <tr>
              <th className="text-left px-4 py-3">Created</th>
              <th className="text-left px-4 py-3">Customer</th>
              <th className="text-left px-4 py-3">Email</th>
              <th className="text-left px-4 py-3">AM</th>
              <th className="text-left px-4 py-3">Scope</th>
              <th className="text-left px-4 py-3">Verdict</th>
              <th className="text-right px-4 py-3">Action</th>
            </tr>
          </thead>
          <tbody>
            {customers.length === 0 && (
              <tr><td colSpan={7} className="text-center py-12 text-slate-400">No customers yet — waiting for the first Chargebee customer.created webhook.</td></tr>
            )}
            {customers.map(c => (
              <tr key={c.cb_customer_id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-4 py-3 text-slate-600 whitespace-nowrap">{fmtDate(c.cb_created_at)}</td>
                <td className="px-4 py-3">
                  <div className="font-medium text-zoca-ink">{c.biz_name ?? "(no biz)"}</div>
                  <div className="text-xs text-slate-500 font-mono">{c.cb_customer_id}</div>
                </td>
                <td className="px-4 py-3 text-slate-600">{c.email ?? "—"}</td>
                <td className="px-4 py-3 text-slate-600">{c.am_name ?? "—"}</td>
                <td className="px-4 py-3"><ScopeChip scope={c.scope} /></td>
                <td className="px-4 py-3"><VerdictPill c={c} /></td>
                <td className="px-4 py-3 text-right">
                  {c.status === "ready" ? (
                    <Link href={`/reports/${c.cb_customer_id}`} className="text-zoca-accent font-medium hover:underline">
                      Open report →
                    </Link>
                  ) : c.status === "out_of_scope" ? (
                    <span className="text-slate-400">—</span>
                  ) : (
                    <span className="text-slate-400 text-sm">{c.status}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
