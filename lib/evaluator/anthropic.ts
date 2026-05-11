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
              "Submit the final structured payment-validation analysis. " +
              "Call this with the complete report JSON object conforming to the " +
              "schema described in the system prompt (the same shape as " +
              "report_schema.example.json — Be Beauty Studio worked example). " +
              "Every top-level key listed below is REQUIRED. " +
              "Always emit a text content block with the full Markdown analysis " +
              "BEFORE calling this tool.",
            // Schema requires all 11 top-level keys from report_schema.example.json
            // so the model is forced to populate the full report. Nested objects
            // are still permissive (additionalProperties:true) because their
            // detailed shape is described in the system prompt.
            input_schema: {
              type: "object",
              properties: {
                meta: {
                  type: "object",
                  description: "Doc header/footer metadata: classification_banner, title, subtitle, subject_account, header_text",
                  additionalProperties: true,
                },
                exec: {
                  type: "object",
                  description: "Executive summary — the verdict block displayed on the dashboard and Slack.",
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
                    recommended_action_label: {
                      type: "string",
                      description: "Short imperative phrase — e.g. 'AM-led recovery within 7 days', 'Onboard normally', 'Refund and re-entry trigger'. Include the word 'AM' if the AM team needs to act.",
                    },
                    driver: {
                      type: "string",
                      description: "One-line reason for the verdict, citing the specific Module 02 rule that drove the decision.",
                    },
                    reinforcing_flags: {
                      type: "string",
                      description: "Single string listing 2-4 additional flags that reinforce the verdict (semicolon-separated).",
                    },
                    mitigating_factors: {
                      type: "string",
                      description: "Single string listing factors that argue AGAINST the verdict (semicolon-separated). Use empty string if none.",
                    },
                    summary_paragraphs: {
                      type: "array",
                      items: { type: "string" },
                      description: "4-6 paragraph executive summary, in order.",
                    },
                    net_retention_picture: {
                      type: "string",
                      description: "One-paragraph retention outlook.",
                    },
                    likely_outcome: {
                      type: "string",
                      description: "Most probable outcome if no action is taken (refund, churn, retain, etc.).",
                    },
                  },
                  required: [
                    "verdict_label", "verdict_status", "recommended_action_label",
                    "driver", "reinforcing_flags", "mitigating_factors",
                    "summary_paragraphs", "net_retention_picture", "likely_outcome",
                  ],
                  additionalProperties: true,
                },
                section1: { type: "object", description: "Subject identifier + data sources tables", additionalProperties: true },
                section3_risks: { type: "object", description: "Risk register with intro + risks array", additionalProperties: true },
                section4_framework: { type: "object", description: "ICP framework application: tier_application, vertical_lock_text, step1 array, step2 array", additionalProperties: true },
                section5_pointers: { type: "array", description: "Post-payment pointer tasks", items: { type: "object", additionalProperties: true } },
                section6_actions: { type: "object", description: "Recommended actions table", additionalProperties: true },
                section7_systemic: { type: "object", description: "Systemic recommendations", additionalProperties: true },
                section8_gaps: { type: "object", description: "Open gaps + data engineering followups", additionalProperties: true },
                section9_evidence: { type: "object", description: "Evidence appendix", additionalProperties: true },
                references: { type: "object", description: "Source references", additionalProperties: true },
              },
              required: [
                "meta", "exec", "section1", "section3_risks", "section4_framework",
                "section5_pointers", "section6_actions", "section7_systemic",
                "section8_gaps", "section9_evidence", "references",
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
    let reportData: any = null;
    for (const block of res.content as any[]) {
      if (block.type === "text") markdown += block.text;
      else if (block.type === "tool_use" && block.name === TOOL_NAME) {
        reportData = block.input;
      }
    }
    if (!reportData) {
      throw new Error("model did not call submit_analysis tool");
    }
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
    "1) Write the full Markdown analysis as a TEXT content block. Include the verdict, the Module 02 rule that drives it, the reinforcing flags, the comms analysis, and the recommended action. Quote specific evidence.",
    "2) Then call the `submit_analysis` tool. The tool input MUST include `exec.verdict_label` (one of: ICP, Review, Not ICP), `exec.verdict_status` (PASS/WARN/FAIL), `exec.driver` (one-line reason), `exec.recommended_action_label`, `exec.reinforcing_flags`, `exec.mitigating_factors`, `exec.summary_paragraphs`, `exec.net_retention_picture`, `exec.likely_outcome`, plus ALL the other top-level sections (meta, section1, section3_risks, section4_framework, section5_pointers, section6_actions, section7_systemic, section8_gaps, section9_evidence, references). Do not skip any required field — the dashboard and the Word doc renderer both depend on them.",
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
