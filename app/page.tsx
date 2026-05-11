/**
 * Dashboard home — list of all Chargebee customers since the floor date.
 *
 * Visual styling ported from zoca-dispute-dashboard: hero with shimmer
 * gradient title, ambient sparkles, status bar, soft card stat strip,
 * inkonsurface table.
 */

import { listCustomersSinceFloor, type Customer } from "@/lib/db/queries";
import Link from "next/link";
import AmbientSparkles from "@/components/AmbientSparkles";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function VerdictPill({ c }: { c: Customer }) {
  if (c.status === "pending" || c.status === "processing") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-elevated border border-line text-ink-dim text-xs">
        <span className="live-dot" /> {c.status}
      </span>
    );
  }
  if (c.status === "failed") {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent-red-bg border border-accent-red/40 text-accent-red text-xs font-medium"
        title={c.failure_reason ?? ""}
      >
        ⚠️ failed
      </span>
    );
  }
  if (c.scope !== "discovery_first_pay") {
    const reason =
      c.scope === "no_subscription"
        ? "no sub yet"
        : c.scope === "other_subscription"
        ? "non-Discovery"
        : c.scope === "discovery_addon"
        ? "Discovery add-on"
        : c.scope === "pre_floor"
        ? "pre-floor"
        : c.scope;
    return <span className="text-ink-dim text-xs">— {reason}</span>;
  }
  if (c.verdict === "icp")
    return (
      <span className="verdict-pill inline-flex items-center px-2.5 py-0.5 rounded-full bg-accent-green-bg border border-accent-green/40 text-accent-green text-xs font-semibold">
        ✅ ICP
      </span>
    );
  if (c.verdict === "review")
    return (
      <span className="verdict-pill inline-flex items-center px-2.5 py-0.5 rounded-full bg-accent-yellow-bg border border-accent-yellow/40 text-accent-yellow text-xs font-semibold">
        ⚠️ Review
      </span>
    );
  if (c.verdict === "not_icp")
    return (
      <span className="verdict-pill inline-flex items-center px-2.5 py-0.5 rounded-full bg-accent-red-bg border border-accent-red/40 text-accent-red text-xs font-semibold">
        ❌ Not ICP
      </span>
    );
  return <span className="text-ink-dim text-xs">—</span>;
}

function ScopeChip({ scope }: { scope: Customer["scope"] }) {
  const map: Record<Customer["scope"], { label: string; cls: string }> = {
    discovery_first_pay: { label: "Discovery first-pay", cls: "bg-accent-blue-bg text-accent-blue-strong border border-accent-blue/30" },
    discovery_addon: { label: "Discovery add-on", cls: "bg-accent-purple-bg text-accent-purple-strong border border-accent-purple/30" },
    other_subscription: { label: "Non-Discovery sub", cls: "bg-elevated text-ink-muted border border-line" },
    no_subscription: { label: "No sub yet", cls: "bg-elevated text-ink-dim border border-line" },
    pre_floor: { label: "Pre-floor", cls: "bg-accent-yellow-bg text-accent-yellow border border-accent-yellow/30" },
    pending: { label: "Pending", cls: "bg-elevated text-ink-dim border border-line" },
  };
  const v = map[scope] ?? { label: scope, cls: "bg-elevated text-ink-muted border border-line" };
  return <span className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium ${v.cls}`}>{v.label}</span>;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toISOString().slice(0, 16).replace("T", " ") + "Z";
}

function Feature({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-accent-pink">•</span>
      {children}
    </span>
  );
}

export default async function Page() {
  let customers: Customer[] = [];
  let dbError: string | null = null;
  try {
    customers = await listCustomersSinceFloor();
  } catch (e: any) {
    dbError = e.message;
  }

  const refreshTime = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  const refreshDate = new Date().toISOString().slice(0, 10);

  const totals = {
    all: customers.length,
    icp: customers.filter((c) => c.verdict === "icp").length,
    review: customers.filter((c) => c.verdict === "review").length,
    not_icp: customers.filter((c) => c.verdict === "not_icp").length,
    out_of_scope: customers.filter((c) => c.status === "out_of_scope").length,
    pending: customers.filter((c) => c.status === "pending" || c.status === "processing").length,
    failed: customers.filter((c) => c.status === "failed").length,
  };

  return (
    <div className="space-y-8 sm:space-y-10 relative">
      <AmbientSparkles />

      {/* HERO */}
      <section className="anim-rise pt-8 sm:pt-12 relative flex flex-col items-center text-center">
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-line bg-surface/50">
          <span className="live-dot" />
          <span className="text-sm text-ink-muted">
            Live Chargebee + Stripe + Metabase · auto-scored by Claude
          </span>
        </div>

        <div className="relative inline-block mt-6 sm:mt-8">
          <span aria-hidden className="header-spark text-accent-pink text-sm" style={{ top: "-12px", left: "-22px", animationDelay: "0s" }}>✦</span>
          <span aria-hidden className="header-spark text-accent-purple text-xs" style={{ top: "-4px", right: "-26px", animationDelay: "0.7s" }}>✦</span>
          <span aria-hidden className="header-spark text-accent-yellow text-sm" style={{ bottom: "8px", right: "-12px", animationDelay: "1.4s" }}>✦</span>
          <h1 className="hero-float text-pink-shimmer text-5xl sm:text-6xl lg:text-7xl xl:text-8xl font-extrabold tracking-tight leading-[0.95] m-0">
            Post-Payment Reviews
          </h1>
        </div>

        <p className="mt-4 sm:mt-6 max-w-2xl text-sm sm:text-base lg:text-lg text-ink-muted leading-relaxed">
          Which new Discovery customers Zoca should keep, route to an AM, or refund — auto-generated
          the moment a Chargebee <code className="font-mono text-accent-pink">customer.created</code> webhook fires.
        </p>

        <div className="mt-5 sm:mt-7 flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm text-ink-muted">
          <Feature>Module 02 ICP framework</Feature>
          <Feature>11-section Word doc per customer</Feature>
          <Feature>Slack auto-post on verdict</Feature>
        </div>
      </section>

      {dbError && (
        <div className="rounded-2xl border border-accent-red/40 bg-accent-red-bg/40 px-5 py-4 text-sm text-accent-red">
          <strong className="text-ink">Database connection error:</strong> {dbError}
          <div className="text-xs text-ink-dim mt-2">
            Run <code className="font-mono">npm run db:migrate</code> to create the schema, and
            check <code className="font-mono">POSTGRES_URL</code> in env.
          </div>
        </div>
      )}

      {/* STATUS BAR */}
      <section className="anim-rise rounded-2xl border border-line bg-surface/50 backdrop-blur-sm px-4 sm:px-5 py-3 sm:py-4 flex items-center justify-between flex-wrap gap-3" style={{ animationDelay: "0.10s" }}>
        <div className="text-xs sm:text-sm text-ink-muted">
          <span className="text-ink-dim mr-2">SHOWING</span>
          <span className="text-ink font-semibold">{customers.length}</span>
          <span className="text-ink-dim mx-1">since floor</span>
          <span className="text-ink-dim mx-2 sm:mx-3">·</span>
          <span className="text-ink-dim mr-2">LAST REFRESH</span>
          <span className="text-ink font-semibold tabular-nums">{refreshTime}</span>
          <span className="text-ink-dim mx-2 sm:mx-3 hidden sm:inline">·</span>
          <span className="text-ink-dim hidden sm:inline tabular-nums">{refreshDate}</span>
        </div>
        <div className="text-xs text-ink-dim">
          Auto-refresh on dashboard reload · cron-free
        </div>
      </section>

      {/* STAT STRIP */}
      <section className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 anim-cascade">
        {[
          { label: "Total since floor", value: totals.all, tone: "ink" },
          { label: "✅ ICP", value: totals.icp, tone: "green" },
          { label: "⚠️ Review", value: totals.review, tone: "yellow" },
          { label: "❌ Not ICP", value: totals.not_icp, tone: "red" },
          { label: "Out of scope", value: totals.out_of_scope, tone: "dim" },
          { label: "Pending", value: totals.pending, tone: "dim" },
          { label: "Failed", value: totals.failed, tone: "red" },
        ].map((s, i) => {
          const toneCls =
            s.tone === "green" ? "text-accent-green"
            : s.tone === "yellow" ? "text-accent-yellow"
            : s.tone === "red" ? "text-accent-red"
            : s.tone === "dim" ? "text-ink-dim"
            : "text-ink";
          return (
            <div
              key={s.label}
              className="stat-card rounded-2xl border border-line bg-surface/50 backdrop-blur-sm p-4"
            >
              <div className="text-xs text-ink-dim">{s.label}</div>
              <div className={`text-2xl font-bold mt-1 ${toneCls}`}>{s.value}</div>
            </div>
          );
        })}
      </section>

      {/* TABLE */}
      <section className="anim-rise rounded-2xl border border-line bg-surface overflow-hidden" style={{ animationDelay: "0.32s" }}>
        <table className="w-full text-sm">
          <thead className="bg-elevated text-ink-dim uppercase tracking-wide text-xs">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Created</th>
              <th className="text-left px-4 py-3 font-medium">Customer</th>
              <th className="text-left px-4 py-3 font-medium">Email</th>
              <th className="text-left px-4 py-3 font-medium">AM</th>
              <th className="text-left px-4 py-3 font-medium">Scope</th>
              <th className="text-left px-4 py-3 font-medium">Verdict</th>
              <th className="text-right px-4 py-3 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {customers.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center py-12 text-ink-faint">
                  No customers yet — waiting for the first Chargebee customer.created webhook.
                </td>
              </tr>
            )}
            {customers.map((c) => (
              <tr key={c.cb_customer_id} className="table-row-anim row-sweep border-t border-line-soft hover:bg-elevated transition-colors">
                <td className="px-4 py-3 text-ink-muted whitespace-nowrap tabular-nums">{fmtDate(c.cb_created_at)}</td>
                <td className="px-4 py-3">
                  <div className="font-semibold text-ink">{c.biz_name ?? "(no biz)"}</div>
                  <div className="text-xs text-ink-dim font-mono">{c.cb_customer_id}</div>
                </td>
                <td className="px-4 py-3 text-ink-muted">{c.email ?? "—"}</td>
                <td className="px-4 py-3 text-ink-muted">{c.am_name ?? "—"}</td>
                <td className="px-4 py-3"><ScopeChip scope={c.scope} /></td>
                <td className="px-4 py-3"><VerdictPill c={c} /></td>
                <td className="px-4 py-3 text-right">
                  {c.status === "ready" ? (
                    <Link
                      href={`/reports/${c.cb_customer_id}`}
                      className="text-accent-blue font-medium hover:text-accent-blue-strong transition group"
                    >
                      Open report <span className="link-arrow inline-block">→</span>
                    </Link>
                  ) : c.status === "out_of_scope" ? (
                    <span className="text-ink-faint">—</span>
                  ) : (
                    <span className="text-ink-faint text-sm">{c.status}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
