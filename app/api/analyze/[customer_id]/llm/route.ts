/**
 * Stage 3 of the analyze pipeline — LLM evaluation + docx render + Slack post.
 *
 * Reads the complete bundle from Blob (saved by Stage 2), calls Anthropic
 * Claude to produce Markdown + structured JSON, renders the Word doc, uploads
 * to Vercel Blob, updates DB with the verdict, and posts to Slack.
 */

import { NextRequest, NextResponse } from "next/server";
import { evaluate } from "@/lib/evaluator/anthropic";
import { renderAndUpload } from "@/lib/render/render";
import { postCustomerReport } from "@/lib/slack";
import { fetchJson } from "@/lib/stage-store";
import { setCustomerReport, setCustomerStatus, logEvent, getCustomer } from "@/lib/db/queries";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: { customer_id: string } }) {
  const customerId = ctx.params.customer_id;
  if (!customerId) return NextResponse.json({ ok: false, error: "missing_customer_id" }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const bundleUrl: string | undefined = body.bundle_url;
  if (!bundleUrl) {
    return NextResponse.json({ ok: false, error: "missing_bundle_url" }, { status: 400 });
  }

  // Load the complete bundle (with comms)
  let bundle: any;
  try {
    bundle = await fetchJson(bundleUrl);
  } catch (e: any) {
    await setCustomerStatus(customerId, "failed", `stage3_load: ${e.message}`);
    await logEvent(customerId, "stage3_failed", { error: e.message });
    return NextResponse.json({ ok: false, stage: "stage3_load", error: e.message }, { status: 500 });
  }
  await logEvent(customerId, "stage3_started", {});

  // --- LLM evaluation -----------------------------------------------------
  let evalResult;
  try {
    evalResult = await evaluate({ bundle });
    await logEvent(customerId, "llm_eval_done", { markdown_chars: evalResult.markdown.length });
  } catch (e: any) {
    await setCustomerStatus(customerId, "failed", `evaluator: ${e.message}`);
    await logEvent(customerId, "stage3_failed", { stage: "evaluator", error: e.message });
    return NextResponse.json({ ok: false, stage: "evaluator", error: e.message }, { status: 500 });
  }

  // --- Render docx + upload to Blob ---------------------------------------
  let render;
  try {
    render = await renderAndUpload({
      cbCustomerId: customerId,
      reportData: evalResult.reportData,
      markdown: evalResult.markdown,
    });
    await logEvent(customerId, "docx_rendered", { bytes: render.bytes });
  } catch (e: any) {
    render = null;
    await logEvent(customerId, "render_failed", { error: e.message });
  }

  // --- Update DB with the final verdict + blob URLs -----------------------
  const verdict = evalResult.reportData?.exec?.verdict_label?.toLowerCase()?.replace(/\s+/g, "_") ?? null;
  const verdictNorm: "icp" | "review" | "not_icp" | null =
    verdict === "icp" ? "icp"
    : verdict === "review" ? "review"
    : verdict === "not_icp" ? "not_icp"
    : null;
  const keyFlags: string[] = evalResult.reportData?.exec?.reinforcing_flags
    ? [evalResult.reportData.exec.reinforcing_flags] : [];

  await setCustomerReport(customerId, {
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

  // --- Slack post ---------------------------------------------------------
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
    console.error("[stage3] slack post failed:", e.message);
    await logEvent(customerId, "slack_failed", { error: e.message });
  }

  await logEvent(customerId, "stage3_done", { verdict: verdictNorm });
  return NextResponse.json({ ok: true, status: "ready", verdict: verdictNorm });
}
