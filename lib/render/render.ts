/**
 * Renders the Word doc from a structured report-data JSON, then uploads to
 * Vercel Blob and returns the public URL.
 *
 * The actual template lives in template.js (copied from the validator repo —
 * single source of truth). We import via require to use the existing JS.
 */

import { put } from "@vercel/blob";
import { Packer } from "docx";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildReport } = require("./template");

export type RenderResult = {
  docxUrl: string;
  jsonUrl: string;
  mdUrl: string;
  bytes: number;
};

export async function renderAndUpload(args: {
  cbCustomerId: string;
  reportData: any;
  markdown: string;
}): Promise<RenderResult> {
  const doc = buildReport(args.reportData);
  const buf = await Packer.toBuffer(doc);

  const baseKey = `reports/${args.cbCustomerId}`;
  const [docxResult, jsonResult, mdResult] = await Promise.all([
    put(`${baseKey}.docx`, buf, {
      access: "public",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      addRandomSuffix: false,
      allowOverwrite: true,
    }),
    put(`${baseKey}.report_data.json`, JSON.stringify(args.reportData, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    }),
    put(`${baseKey}.analysis.md`, args.markdown, {
      access: "public",
      contentType: "text/markdown; charset=utf-8",
      addRandomSuffix: false,
      allowOverwrite: true,
    }),
  ]);

  return {
    docxUrl: docxResult.url,
    jsonUrl: jsonResult.url,
    mdUrl: mdResult.url,
    bytes: buf.length,
  };
}
