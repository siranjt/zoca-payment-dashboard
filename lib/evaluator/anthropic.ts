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

// Default to Sonnet (fast, comparable quality). Override with ANTHROPIC_MODEL.
// IMPORTANT: Opus regularly exceeds 60s on this prompt — only use it if Vercel
// Fluid Compute is verified to be granting >60s timeouts.
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
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

function extractJsonBlock(raw: string): any {
  // Find the LAST fenced ```json … ``` block in the response.
  const re = /```json\s*([\s\S]*?)```/g;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) last = m[1];
  if (!last) throw new Error("no ```json block found in LLM output");
  try {
    return JSON.parse(last.trim());
  } catch (e: any) {
    throw new Error(`json parse failed: ${e.message}`);
  }
}

function extractMarkdown(raw: string): string {
  // The Markdown is everything BEFORE the final ```json block.
  const idx = raw.lastIndexOf("```json");
  return idx === -1 ? raw.trim() : raw.slice(0, idx).trim();
}

// Hard cap on a single LLM round-trip. Sized to fit comfortably inside
// Vercel's Fluid-Compute budget (~300s minus ~60s bundle = ~240s left for LLM
// + render + slack). 180s gives Sonnet plenty of room (typical: 40–90s).
// Override via ANTHROPIC_TIMEOUT_MS. maxRetries=0 in the client config means
// timeouts fail immediately rather than spawning 2 silent retries.
const REQUEST_TIMEOUT_MS = Number(process.env.ANTHROPIC_TIMEOUT_MS ?? 180_000);

async function callOnce(systemPrompt: string, userPrompt: string): Promise<string> {
  const t0 = Date.now();
  try {
    const res = await client.messages.create(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      },
      { timeout: REQUEST_TIMEOUT_MS },
    );
    const elapsed = Date.now() - t0;
    console.log(`[llm] model=${MODEL} elapsed_ms=${elapsed} stop=${res.stop_reason}`);
    // Concatenate all text blocks
    return res.content.map((b: any) => b.type === "text" ? b.text : "").join("");
  } catch (e: any) {
    const elapsed = Date.now() - t0;
    console.error(`[llm] FAILED model=${MODEL} elapsed_ms=${elapsed} err=${e?.message ?? e}`);
    throw new Error(`llm_call: ${e?.message ?? String(e)} (elapsed ${elapsed}ms, model ${MODEL})`);
  }
}

/**
 * Run the evaluation. Retries the LLM call once on JSON-parse failure.
 * Throws if both attempts fail; the caller falls back to Markdown-only.
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
    "Now produce the full Markdown analysis, then the fenced ```json block per the schema.",
  ].join("\n");

  let raw = "";
  let parseErr: Error | null = null;
  let reportData: any = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    raw = await callOnce(systemPrompt, attempt === 0
      ? userPrompt
      : userPrompt + "\n\n[RETRY] Your previous response had malformed JSON. Re-emit the full response with VALID parseable JSON in the ```json block at the end.");
    try {
      reportData = extractJsonBlock(raw);
      parseErr = null;
      break;
    } catch (e: any) {
      parseErr = e;
    }
  }
  if (parseErr) throw new Error(`evaluator: ${parseErr.message}`);

  return { markdown: extractMarkdown(raw), reportData, raw };
}
