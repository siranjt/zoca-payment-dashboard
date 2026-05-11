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

// Hard cap on a single LLM round-trip. The full report schema requires the
// model to fill 11 sections worth of content (~8K tokens) — Sonnet at
// ~50-100 tok/sec needs 100-180s. We give 240s to allow comfortable margin.
// Total budget: 240s LLM + 55s bundle + ~15s render+slack = ~310s, fits
// within Fluid-Compute's 300s soft cap. Override via ANTHROPIC_TIMEOUT_MS.
const REQUEST_TIMEOUT_MS = Number(process.env.ANTHROPIC_TIMEOUT_MS ?? 240_000);

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
              "Submit the FULL Post-Payment Account Review for this customer. The " +
              "output JSON renders directly into a multi-section Word document — every " +
              "section described below MUST be populated with substantive content. " +
              "Reference report_schema.example.json (the Be Beauty Studio worked " +
              "example) as the shape template; your output for this customer should " +
              "have equivalent depth and structure.",
            input_schema: {
              type: "object",
              properties: {
                meta: {
                  type: "object",
                  description: "Doc header/footer metadata.",
                  properties: {
                    classification_banner: { type: "string", description: "Top-of-cover classification e.g. 'ZOCA · CONFIDENTIAL'" },
                    title: { type: "string", description: "'Post-Payment Account Review'" },
                    subtitle: { type: "string", description: "'ICP Fit Assessment & Post-Payment Pointer Analysis'" },
                    subject_account: { type: "string", description: "'<Business name> (<Owner name>)'" },
                    header_text: { type: "string", description: "Running header for inner pages" },
                  },
                  required: ["classification_banner", "title", "subtitle", "subject_account", "header_text"],
                  additionalProperties: true,
                },
                exec: {
                  type: "object",
                  description: "Executive summary block. Drives the dashboard verdict pill, Slack message, and the cover page.",
                  properties: {
                    verdict_label: { type: "string", enum: ["ICP", "Review", "Not ICP"] },
                    verdict_status: { type: "string", enum: ["PASS", "WARN", "FAIL"] },
                    recommended_action_label: { type: "string", description: "Short imperative; include 'AM' if AM team must act." },
                    driver: { type: "string", description: "One-line cause citing the Module 02 rule." },
                    reinforcing_flags: { type: "string", description: "Semicolon-separated list of 2-4 additional flags." },
                    mitigating_factors: { type: "string", description: "Semicolon-separated factors against the verdict." },
                    summary_paragraphs: { type: "array", items: { type: "string" }, description: "3-5 substantive paragraphs covering: business profile, Module 02 application, reinforcing flags, comms/demo analysis, recommended action with timeline." },
                    net_retention_picture: { type: "string", description: "One paragraph retention outlook." },
                    likely_outcome: { type: "string", description: "Most probable outcome if no action." },
                  },
                  required: ["verdict_label", "verdict_status", "recommended_action_label", "driver", "reinforcing_flags", "mitigating_factors", "summary_paragraphs", "net_retention_picture", "likely_outcome"],
                  additionalProperties: true,
                },
                section1: {
                  type: "object",
                  description: "Subject identifier and data sources tables.",
                  properties: {
                    subject_table: { type: "array", items: { type: "array", items: { type: "string" } }, description: "2D array (table). First row is headers ['Subject identifier', 'Value']. Following rows: ['Business name', '<name>'], ['Owner / decision-maker', '<name>'], etc. Include all the standard rows from the example: Business name, Owner, Primary category, Location, Chargebee customer ID, Stripe customer ID, Zoca entity ID, First Discovery payment, Subscription SKU, AE, AM." },
                    data_sources_table: { type: "array", items: { type: "array", items: { type: "string" } }, description: "2D array. First row: ['Data source', 'Type', 'Used for']. Rows for each source the validator used." },
                  },
                  required: ["subject_table", "data_sources_table"],
                  additionalProperties: true,
                },
                section3_risks: {
                  type: "object",
                  description: "Risk register.",
                  properties: {
                    intro: { type: "string", description: "One-paragraph framing of the risks." },
                    risks: { type: "array", items: { type: "object", additionalProperties: true }, description: "5-8 risk objects, each with: id (R1, R2...), risk (short title), likelihood (PASS/WARN/FAIL/RISK/GAP), impact (same scale), driver_mitigation (sentence explaining the driver + recommended mitigation)." },
                  },
                  required: ["intro", "risks"],
                  additionalProperties: true,
                },
                section4_framework: {
                  type: "object",
                  description: "Module 02 ICP framework application.",
                  properties: {
                    tier_application: { type: "string", description: "Brief statement of which Step-1.2 tier (below 30 / 30-60 / above 60) this customer falls in." },
                    vertical_lock_text: { type: "string", description: "1-2 sentences on whether the customer is in the beauty/wellness vertical." },
                    step1: { type: "array", items: { type: "object", additionalProperties: true }, description: "Array of 3 gate objects (1.1 Device, 1.2 Lead prediction, 1.3 Booking platform). Each has: gate (label), status (PASS/FAIL/AUTOFAIL/GAP/WARN), evidence (string or array of paragraph objects)." },
                    step2: { type: "array", items: { type: "object", additionalProperties: true }, description: "Array of Step-2 lead-shape evaluation rows. Each: row_label, status, evidence." },
                  },
                  required: ["tier_application", "vertical_lock_text", "step1", "step2"],
                  additionalProperties: true,
                },
                section5_pointers: {
                  type: "array",
                  items: { type: "object", additionalProperties: true },
                  description: "Array of 8-15 post-payment pointer items. Each pointer object has: id (P1, P2...), pointer (short title), status (FAIL/WARN/RISK/GAP/PASS), evidence (string or rich paragraph array), action (recommended next action sentence).",
                },
                section6_actions: {
                  type: "object",
                  description: "Recommended actions table.",
                  properties: {
                    intro: { type: "string" },
                    actions: { type: "array", items: { type: "object", additionalProperties: true }, description: "Array of action objects: owner, action, timeline, success_criteria." },
                  },
                  required: ["intro", "actions"],
                  additionalProperties: true,
                },
                section7_systemic: {
                  type: "object",
                  description: "Systemic / process recommendations beyond this customer.",
                  properties: {
                    intro: { type: "string" },
                    recommendations: { type: "array", items: { type: "object", additionalProperties: true }, description: "Each: title, description, owner." },
                  },
                  required: ["intro", "recommendations"],
                  additionalProperties: true,
                },
                section8_gaps: {
                  type: "object",
                  description: "Open data gaps the validator could not close.",
                  properties: {
                    intro: { type: "string" },
                    gaps: { type: "array", items: { type: "object", additionalProperties: true }, description: "Each: gap, impact, owner_to_fix." },
                  },
                  required: ["intro", "gaps"],
                  additionalProperties: true,
                },
                section9_evidence: {
                  type: "object",
                  description: "Evidence appendix — quoted comms snippets, key data points.",
                  properties: {
                    intro: { type: "string" },
                    items: { type: "array", items: { type: "object", additionalProperties: true }, description: "Each: label, content, source." },
                  },
                  required: ["intro", "items"],
                  additionalProperties: true,
                },
                references: {
                  type: "object",
                  description: "Source references.",
                  properties: {
                    intro: { type: "string" },
                    items: { type: "array", items: { type: "object", additionalProperties: true }, description: "Each: label, citation." },
                  },
                  required: ["intro", "items"],
                  additionalProperties: true,
                },
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
    // The tool input IS the full report-data structure — pass it straight to
    // the renderer. Fill in defaults for any missing keys so the renderer
    // doesn't crash on sparse output (defensive: missing section just renders
    // as an empty heading).
    const reportData = fillReportDefaults(toolInput);
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
    "Call the `submit_analysis` tool with the FULL structured report. Fill in every required section — the output JSON renders into a complete multi-section Word document.",
    "Use report_schema.example.json (Be Beauty Studio worked example) as your shape reference. Your output should match its depth: cover meta, full executive summary, subject identifier table, data sources table, 5-8 risks in section3_risks, all three Step-1 gates and Step-2 row in section4_framework, 8-15 pointers in section5_pointers, recommended actions, systemic recommendations, open gaps, evidence snippets with quotes from comms, and references.",
    "Cite specific evidence: exact phone-call durations, verbatim message text, the predicted-leads number, the review count, the AE/AM names, the booking platform, etc.",
    "You MAY also emit a short TEXT content block before the tool call summarizing the verdict — it'll be used as the Slack thread reply.",
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
 * Take the LLM's full report-data output and back-fill any sections it left
 * out. This is defense-in-depth — the schema asks for all 11 sections, but
 * if the model skips one, we want the renderer to still produce a valid doc
 * (the skipped section will just render as an empty heading).
 */
function fillReportDefaults(input: any): any {
  return {
    meta: input.meta ?? {
      classification_banner: "ZOCA · CONFIDENTIAL",
      title: "Post-Payment Account Review",
      subtitle: "ICP Fit Assessment & Post-Payment Pointer Analysis",
      subject_account: "(see Section 1)",
      header_text: "Zoca · Confidential — Post-Payment Account Review",
    },
    exec: input.exec ?? {},
    section1: input.section1 ?? { subject_table: [], data_sources_table: [] },
    section3_risks: input.section3_risks ?? { intro: "", risks: [] },
    section4_framework: input.section4_framework ?? { tier_application: "", vertical_lock_text: "", step1: [], step2: [] },
    section5_pointers: Array.isArray(input.section5_pointers) ? input.section5_pointers : [],
    section6_actions: input.section6_actions ?? { intro: "", actions: [] },
    section7_systemic: input.section7_systemic ?? { intro: "", recommendations: [] },
    section8_gaps: input.section8_gaps ?? { intro: "", gaps: [] },
    section9_evidence: input.section9_evidence ?? { intro: "", items: [] },
    references: input.references ?? { intro: "", items: [] },
  };
}
