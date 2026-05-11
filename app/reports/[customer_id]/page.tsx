/**
 * /reports/<cb_customer_id> — single report viewer.
 *
 * Layout (themed to match zoca-dispute-dashboard):
 *   - Back link
 *   - Customer header + Preview/JSON action buttons
 *   - Verdict callout banner (status-coloured)
 *   - Key facts grid
 *   - Full analysis markdown (rendered in mono pre block)
 */

import { getCustomer } from "@/lib/db/queries";
import Link from "next/link";
import { DocxPreviewButton } from "@/components/DocxPreviewButton";

export const dynamic = "force-dynamic";

function VerdictBlock({
  verdict,
  needsAmCall,
  oneLine,
}: {
  verdict: string | null;
  needsAmCall: boolean;
  oneLine: string | null;
}) {
  const pill =
    verdict === "icp"
      ? { text: "✅ ICP", border: "border-accent-green/40", bg: "bg-accent-green-bg", color: "text-accent-green" }
      : verdict === "review"
      ? { text: "⚠️ Review", border: "border-accent-yellow/40", bg: "bg-accent-yellow-bg", color: "text-accent-yellow" }
      : verdict === "not_icp"
      ? { text: "❌ Not ICP", border: "border-accent-red/40", bg: "bg-accent-red-bg", color: "text-accent-red" }
      : { text: "Pending", border: "border-line", bg: "bg-elevated", color: "text-ink-dim" };
  return (
    <div className={`rounded-2xl border ${pill.border} ${pill.bg} px-6 py-5 mb-6`}>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2 mb-2">
        <span className={`text-3xl font-bold ${pill.color}`}>{pill.text}</span>
        {needsAmCall && (
          <span className="inline-flex items-center gap-1 text-accent-yellow font-semibold">
            <span>🚨</span> Needs AM call
          </span>
        )}
      </div>
      {oneLine && <p className={`text-sm ${pill.color}/90 leading-relaxed`}>{oneLine}</p>}
    </div>
  );
}

function Stat({ label, value, fmt }: { label: string; value: any; fmt?: (v: any) => string }) {
  const display = value === null || value === undefined ? "—" : fmt ? fmt(value) : String(value);
  return (
    <div className="bg-surface border border-line rounded-2xl p-4">
      <div className="text-xs text-ink-dim uppercase tracking-wide">{label}</div>
      <div className="text-lg font-semibold text-ink mt-1">{display}</div>
    </div>
  );
}

async function fetchMarkdown(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export default async function ReportPage({ params }: { params: { customer_id: string } }) {
  const c = await getCustomer(params.customer_id);
  if (!c) {
    return (
      <div className="text-center py-12">
        <p className="text-ink-muted">Customer not found in dashboard.</p>
        <Link href="/" className="text-accent-blue hover:text-accent-blue-strong mt-4 inline-block">
          ← Back to dashboard
        </Link>
      </div>
    );
  }

  const md = await fetchMarkdown(c.report_blob_md_url);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/" className="text-sm text-accent-blue hover:text-accent-blue-strong transition">
          ← All reports
        </Link>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-3xl font-bold text-ink leading-tight">
            {c.biz_name ?? c.cb_customer_id}
          </h2>
          <p className="text-sm text-ink-muted mt-2">
            Customer ID: <span className="font-mono text-ink">{c.cb_customer_id}</span>
            {c.email && (
              <>
                {" · "}
                <span className="text-ink-dim">{c.email}</span>
              </>
            )}
            {c.locality && (
              <>
                {" · "}
                {c.locality}
                {c.state_code ? `, ${c.state_code}` : ""}
              </>
            )}
          </p>
        </div>
        <div className="flex gap-2 text-sm flex-shrink-0">
          {c.report_blob_docx_url && (
            <DocxPreviewButton
              docxUrl={c.report_blob_docx_url}
              filename={`${(c.biz_name ?? c.cb_customer_id).replace(/[^a-zA-Z0-9_-]+/g, "_")}_Post_Payment_Review.docx`}
            />
          )}
          {c.report_blob_json_url && (
            <a
              href={c.report_blob_json_url}
              className="px-3 py-1.5 border border-line text-ink-muted rounded-lg hover:bg-elevated transition"
            >
              ↓ JSON
            </a>
          )}
        </div>
      </div>

      <VerdictBlock verdict={c.verdict} needsAmCall={c.needs_am_call} oneLine={c.verdict_one_line} />

      <div>
        <h3 className="text-lg font-semibold mb-3 text-ink">Key facts</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat
            label="AE / AM"
            value={[c.ae_name, c.am_name].filter(Boolean).join(" / ") || null}
          />
          <Stat label="Primary category" value={c.primary_category} />
          <Stat label="Lead source" value={c.lead_source_group ?? c.lead_source} />
          <Stat
            label="6-month lead prediction"
            value={c.predicted_6_month_leads}
            fmt={(v) =>
              v === null
                ? "—"
                : v < 30
                ? `${v} (auto-fail)`
                : v < 60
                ? `${v} (possible)`
                : `${v} (likely)`
            }
          />
          <Stat label="Reviews at onboarding" value={c.total_reviews_at_onb} />
          <Stat label="Avg rating" value={c.avg_rating_at_onb} />
          <Stat label="Booking platform" value={c.booking_platform} />
          <Stat label="Open tickets (30d)" value={c.open_tickets_30d} />
        </div>
      </div>

      {md ? (
        <div>
          <h3 className="text-lg font-semibold mb-3 text-ink">Full analysis</h3>
          <article className="bg-surface border border-line rounded-2xl p-6 whitespace-pre-wrap font-mono text-xs text-ink-muted leading-relaxed">
            {md}
          </article>
        </div>
      ) : (
        <div className="rounded-2xl border border-accent-yellow/40 bg-accent-yellow-bg/40 px-5 py-4 text-sm text-accent-yellow">
          <strong className="text-ink">Markdown analysis not yet rendered.</strong> Status:{" "}
          <code className="font-mono">{c.status}</code>
          {c.failure_reason && <p className="mt-2">Reason: {c.failure_reason}</p>}
        </div>
      )}
    </div>
  );
}
