/**
 * Anthropic API client for the LLM evaluator.
 *
 * Loads prompt.md from the repo root and combines it with the bundle data + any
 * Fireflies/HubSpot enrichment to produce both:
 *   - Markdown analysis (for the Slack thread reply)
 *   - Fenced ```json block (for the Word-doc renderer)
 *
 * Implements the "retry once on JSON-parse failure" rule.
 */

import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import type { Bundle } from "@/lib/validator/bundle";

// Default to Haiku — finishes this analysis in 15–30s and stays comfortably
// within Vercel's function budget even on cold starts. Sonnet routinely hits
// 90–150s on this prompt size, which left zero margin and produced repeated
// pipeline_failed events. Quality difference is minimal because the ICP
// framework and rules are fully spelled out in the prompt.
//
// To override: set ANTHROPIC_MODEL=claude-sonnet-4-6 (or opus) in Vercel envs.
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
const MAX_TOKENS = 12_000;

// CRITICAL: disable SDK retries. The default is 2 retries, which on a
// timeout-triggered retry burns 3× the per-request timeout (we saw 151s for a
// "50s timeout" because the SDK silently retried twice). Fail fast instead —
// our eval-level retry on JSON-parse failure handles transient errors at a
// higher level.
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  maxRetries: 0,
});

export type EvalResult = {
  markdown: string;        // the full Markdown analysis (Verdict + Key flags + Check-by-check + ...)
  reportData: any;         // parsed JSON block conforming to report_schema.example.json
  raw: string;             // raw model output (for debugging / re-parsing)
};

function loadPrompt(): string {
  // prompt.md is co-located in the repo root for easy editing
  const promptPath = path.join(process.cwd(), "prompt.md");
  return fs.readFileSync(promptPath, "utf8");
}

// Hard cap on a single LLM round-trip. Sized to fit comfortably inside
// Vercel's Fluid-Compute budget (~300s minus ~60s bundle = ~240s left for LLM
// + render + slack). 180s gives Sonnet plenty of room (typical: 40–90s).
// Override via ANTHROPIC_TIMEOUT_MS. maxRetries=0 in the client config means
// timeouts fail immediately rather than spawning 2 silent retries.
const REQUEST_TIMEOUT_MS = Number(process.env.ANTHROPIC_TIMEOUT_MS ?? 180_000);

const TOOL_NAME = "submit_analysis";

/**
 * Single LLM round-trip using forced tool use. Defining `tool_choice` makes the
 * model REQUIRED to call our tool with structured JSON — Anthropic's API
 * guarantees the input will parse, so we never have to scrape a fenced ```json
 * block out of free-form text (which Haiku was unreliable at emitting).
 *
 * The model is free to also emit a text content block alongside the tool call;
 * we capture that as the Markdown analysis for Slack.
 */
async function callOnce(systemPrompt: string, userPrompt: string): Promise<{ markdown: string; reportData: any }> {
  const t0 = Date.now();
  try {
    const res = await client.messages.create(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        tools: [
          {
            name: TOOL_NAME,
            description:
              "Submit the final ICP verdict and executive summary for this customer. " +
              "Call this with the verdict fields — the dashboard and Slack post depend " +
              "on the verdict_label, driver, and recommended_action_label. The full " +
              "narrative Word doc is generated from your text content block, so write " +
              "that BEFORE calling this tool.",
            // CRITICAL: keep the schema small. Earlier versions required 11 top-level
            // sections and the model timed out at 180s trying to populate all of them.
            // We only force the model to fill the fields the dashboard surfaces; the
            // rest of the docx report sections are filled with defaults in code (see
            // wrapExecAsFullReport in this file).
            input_schema: {
              type: "object",
              properties: {
                verdict_label: {
                  type: "string",
                  enum: ["ICP", "Review", "Not ICP"],
                  description: "Final classification — one of: ICP, Review, Not ICP",
                },
                verdict_status: {
                  type: "string",
                  enum: ["PASS", "WARN", "FAIL"],
                  description: "Status banner color — PASS (green) / WARN (yellow) / FAIL (red)",
                },
                driver: {
                  type: "string",
                  description: "One-line reason for the verdict, citing the specific Module 02 rule.",
                },
                recommended_action_label: {
                  type: "string",
                  description: "Short imperative phrase like 'AM-led recovery within 7 days' or 'Onboard normally'. Include 'AM' if the AM team should act.",
                },
                reinforcing_flags: {
                  type: "string",
                  description: "Semicolon-separated list of 2-4 additional flags that reinforce the verdict.",
                },
                mitigating_factors: {
                  type: "string",
                  description: "Semicolon-separated factors that argue AGAINST the verdict. Empty string if none.",
                },
                summary_paragraphs: {
                  type: "array",
                  items: { type: "string" },
                  description: "3-5 paragraph executive summary.",
                },
                likely_outcome: {
                  type: "string",
                  description: "Most probable outcome if no action is taken.",
                },
              },
              required: [
                "verdict_label", "verdict_status", "driver",
                "recommended_action_label", "reinforcing_flags", "summary_paragraphs",
              ],
              additionalProperties: true,
            },
          },
        ],
        tool_choice: { type: "tool", name: TOOL_NAME },
        messages: [{ role: "user", content: userPrompt }],
      },
      { timeout: REQUEST_TIMEOUT_MS },
    );
    const elapsed = Date.now() - t0;
    console.log(`[llm] model=${MODEL} elapsed_ms=${elapsed} stop=${res.stop_reason} blocks=${res.content.map((b: any) => b.type).join(",")}`);

    let markdown = "";
    let toolInput: any = null;
    for (const block of res.content as any[]) {
      if (block.type === "text") markdown += block.text;
      else if (block.type === "tool_use" && block.name === TOOL_NAME) {
        toolInput = block.input;
      }
    }
    if (!toolInput) {
      throw new Error("model did not call submit_analysis tool");
    }
    // Wrap the flat tool output (verdict fields) into the full report-data
    // structure the docx renderer expects. The narrative markdown content
    // produced by the model becomes the body of the doc; the verdict block
    // becomes the executive summary section.
    const reportData = wrapExecAsFullReport(toolInput, markdown);
    return { markdown: markdown.trim(), reportData };
  } catch (e: any) {
    const elapsed = Date.now() - t0;
    console.error(`[llm] FAILED model=${MODEL} elapsed_ms=${elapsed} err=${e?.message ?? e}`);
    throw new Error(`llm_call: ${e?.message ?? String(e)} (elapsed ${elapsed}ms, model ${MODEL})`);
  }
}

/**
 * Run the evaluation. Forced tool use guarantees parseable JSON on the first
 * attempt, so the old "retry once on JSON-parse failure" loop is no longer
 * needed. Single call, single error mode (network/timeout) handled at a
 * higher level.
 */
export async function evaluate(args: {
  bundle: Bundle;
  fireflies?: any;
  hubspot?: any;
}): Promise<EvalResult> {
  const systemPrompt = loadPrompt();
  const userPrompt = [
    "# Bundle (deterministic data)",
    "```json",
    JSON.stringify(args.bundle, null, 2),
    "```",
    "",
    "# Fireflies enrichment",
    "```json",
    JSON.stringify(args.fireflies ?? null, null, 2),
    "```",
    "",
    "# HubSpot enrichment",
    "```json",
    JSON.stringify(args.hubspot ?? null, null, 2),
    "```",
    "",
    "INSTRUCTIONS:",
    "1) Write a thorough Markdown analysis as a TEXT content block. Include: the verdict, the Module 02 rule that drives it (cite section + rule), the reinforcing flags, key facts from the bundle (lead prediction, reviews, booking platform, AE/AM), the comms analysis, and the recommended action. Quote specific evidence — exact phone-call durations, message text, missed checks, etc.",
    "2) THEN call the `submit_analysis` tool with the verdict fields. Required fields: verdict_label (ICP / Review / Not ICP), verdict_status (PASS / WARN / FAIL), driver (one-line cause), recommended_action_label (short imperative), reinforcing_flags (semicolon-separated), summary_paragraphs (3-5 paragraphs).",
  ].join("\n");

  const { markdown, reportData } = await callOnce(systemPrompt, userPrompt);
  // If the model skipped the text content (some models do that with forced
  // tool use), synthesize a minimal markdown summary from the structured data
  // so Slack still has something to post.
  const finalMarkdown = markdown.length > 50 ? markdown : synthesizeMarkdownFromReport(reportData);
  return { markdown: finalMarkdown, reportData, raw: markdown };
}

/**
 * Fallback for when the model emits only the tool call with no text content.
 * Builds a brief Markdown summary from the structured report data so we have
 * something to post to Slack. Defensive about missing fields.
 */
function synthesizeMarkdownFromReport(report: any): string {
  const exec = report?.exec ?? {};
  const lines: string[] = [];
  if (exec.verdict_label) lines.push(`**Verdict:** ${exec.verdict_label}`);
  if (exec.driver) lines.push(`**One-line driver:** ${exec.driver}`);
  if (exec.recommended_action_label) lines.push(`**Recommended action:** ${exec.recommended_action_label}`);
  if (exec.reinforcing_flags) lines.push(`**Key flag:** ${exec.reinforcing_flags}`);
  lines.push("");
  lines.push("_Full analysis available in the Word doc attached to this thread._");
  return lines.join("\n");
}

/**
 * Wrap the flat tool output into the full 11-section report-data structure
 * the docx renderer expects. The verdict fields go into `exec`; everything
 * else gets sensible defaults so the renderer doesn't crash on missing keys.
 *
 * Keeping the renderer's structure stable lets us add sections back to the
 * LLM-driven output later without re-plumbing the renderer.
 */
function wrapExecAsFullReport(toolInput: any, markdown: string): any {
  const exec = {
    verdict_label: toolInput.verdict_label ?? null,
    verdict_status: toolInput.verdict_status ?? null,
    recommended_action_label: toolInput.recommended_action_label ?? null,
    driver: toolInput.driver ?? null,
    reinforcing_flags: toolInput.reinforcing_flags ?? "",
    mitigating_factors: toolInput.mitigating_factors ?? "",
    summary_paragraphs: Array.isArray(toolInput.summary_paragraphs)
      ? toolInput.summary_paragraphs
      : (markdown ? [markdown] : []),
    net_retention_picture: toolInput.net_retention_picture ?? "",
    likely_outcome: toolInput.likely_outcome ?? "",
  };
  return {
    meta: {
      classification_banner: "ZOCA · CONFIDENTIAL",
      title: "Post-Payment Account Review",
      subtitle: "ICP Fit Assessment & Post-Payment Pointer Analysis",
      subject_account: "(see Section 1)",
      header_text: "Zoca · Confidential — Post-Payment Account Review",
    },
    exec,
    section1: { subject_table: [], data_sources_table: [] },
    section3_risks: { intro: "", risks: [] },
    section4_framework: { tier_application: "", vertical_lock_text: "", step1: [], step2: [] },
    section5_pointers: [],
    section6_actions: { intro: "", actions: [] },
    section7_systemic: { intro: "", recommendations: [] },
    section8_gaps: { intro: "", gaps: [] },
    section9_evidence: { intro: "", items: [] },
    references: { intro: "", items: [] },
    // The full narrative analysis goes here for renderers that want it in
    // one chunk instead of section-by-section.
    full_analysis_markdown: markdown,
  };
}
