/**
 * /reports/<cb_customer_id> — single report viewer.
 *
 * Layout:
 *   - Verdict header (verdict pill + AM call flag + driver one-liner)
 *   - Key facts strip (lead pred, reviews, booking platform, ticket count)
 *   - Action row: download .docx | view JSON | view raw Markdown
 *   - Markdown analysis rendered inline
 */

import { getCustomer } from "@/lib/db/queries";
import Link from "next/link";

export const dynamic = "force-dynamic";

function VerdictBlock({ verdict, needsAmCall, oneLine }: { verdict: string | null; needsAmCall: boolean; oneLine: string | null }) {
  const pill = verdict === "icp" ? { text: "✅ ICP", cls: "bg-emerald-50 text-emerald-700 border-emerald-300" }
    : verdict === "review" ? { text: "⚠️ Review", cls: "bg-amber-50 text-amber-700 border-amber-300" }
    : verdict === "not_icp" ? { text: "❌ Not ICP", cls: "bg-rose-50 text-rose-700 border-rose-300" }
    : { text: "Pending", cls: "bg-slate-50 text-slate-600 border-slate-300" };
  return (
    <div className={`border rounded-lg p-6 mb-6 ${pill.cls}`}>
      <div className="flex items-baseline gap-3 mb-2">
        <span className="text-3xl font-bold">{pill.text}</span>
        {needsAmCall && <span className="text-lg font-bold text-zoca-warn">· 🚨 Needs AM call</span>}
      </div>
      {oneLine && <p className="text-sm">{oneLine}</p>}
    </div>
  );
}

function Stat({ label, value, fmt }: { label: string; value: any; fmt?: (v: any) => string }) {
  const display = value === null || value === undefined ? "—" : fmt ? fmt(value) : String(value);
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-lg font-semibold text-zoca-ink mt-1">{display}</div>
    </div>
  );
}

async function fetchMarkdown(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
}

export default async function ReportPage({ params }: { params: { customer_id: string } }) {
  const c = await getCustomer(params.customer_id);
  if (!c) {
    return <div className="text-center py-12">
      <p className="text-slate-600">Customer not found in dashboard.</p>
      <Link href="/" className="text-zoca-accent hover:underline mt-4 inline-block">← Back to dashboard</Link>
    </div>;
  }

  const md = await fetchMarkdown(c.report_blob_md_url);

  return (
    <div>
      <div className="mb-4">
        <Link href="/" className="text-sm text-zoca-accent hover:underline">← All reports</Link>
      </div>
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-2xl font-bold text-zoca-ink">{c.biz_name ?? c.cb_customer_id}</h2>
        <div className="flex gap-2 text-sm">
          {c.report_blob_docx_url && (
            <a href={c.report_blob_docx_url} className="px-3 py-1.5 border border-zoca-accent text-zoca-accent rounded hover:bg-zoca-info">
              ↓ Download .docx
            </a>
          )}
          {c.report_blob_json_url && (
            <a href={c.report_blob_json_url} className="px-3 py-1.5 border border-slate-300 text-slate-600 rounded hover:bg-slate-50">
              ↓ JSON
            </a>
          )}
        </div>
      </div>
      <p className="text-sm text-slate-600 mb-6">
        Customer ID: <span className="font-mono">{c.cb_customer_id}</span>
        {c.email && <> · <span className="text-slate-500">{c.email}</span></>}
        {c.locality && <> · {c.locality}{c.state_code ? `, ${c.state_code}` : ""}</>}
      </p>

      <VerdictBlock verdict={c.verdict} needsAmCall={c.needs_am_call} oneLine={c.verdict_one_line} />

      <h3 className="text-lg font-semibold mb-3 text-zoca-ink">Key facts</h3>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        <Stat label="AE / AM" value={[c.ae_name, c.am_name].filter(Boolean).join(" / ") || null} />
        <Stat label="Primary category" value={c.primary_category} />
        <Stat label="Lead source" value={c.lead_source_group ?? c.lead_source} />
        <Stat label="6-month lead prediction" value={c.predicted_6_month_leads}
              fmt={v => v === null ? "—" : v < 30 ? `${v} (auto-fail)` : v < 60 ? `${v} (possible)` : `${v} (likely)`} />
        <Stat label="Reviews at onboarding" value={c.total_reviews_at_onb} />
        <Stat label="Avg rating" value={c.avg_rating_at_onb} />
        <Stat label="Booking platform" value={c.booking_platform} />
        <Stat label="Open tickets (30d)" value={c.open_tickets_30d} />
      </div>

      {md ? (
        <>
          <h3 className="text-lg font-semibold mb-3 text-zoca-ink">Full analysis</h3>
          <article className="prose prose-slate max-w-none bg-white border border-slate-200 rounded-lg p-6 whitespace-pre-wrap font-mono text-xs">
            {md}
          </article>
        </>
      ) : (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-6 text-amber-800 text-sm">
          Markdown analysis not yet rendered. Status: <strong>{c.status}</strong>
          {c.failure_reason && <p className="mt-2">Reason: {c.failure_reason}</p>}
        </div>
      )}
    </div>
  );
}
