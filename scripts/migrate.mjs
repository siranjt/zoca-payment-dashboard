#!/usr/bin/env node
// Run schema.sql against POSTGRES_URL.
// Usage: npm run db:migrate
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "@vercel/postgres";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, "..", "lib", "db", "schema.sql");

// Accept any of the common Postgres connection-string names. @vercel/postgres
// reads POSTGRES_URL at module load, so set it up here BEFORE importing sql.
process.env.POSTGRES_URL =
  process.env.POSTGRES_URL ??
  process.env.POSTGRES_PRISMA_URL ??
  process.env.DATABASE_URL ??
  process.env.STORAGE_DATABASE_URL ??
  process.env.STORAGE_URL ??
  process.env.DATABASE_POSTGRES_URL ??
  "";

if (!process.env.POSTGRES_URL) {
  console.error("No Postgres connection string found in env. Set one of: POSTGRES_URL, DATABASE_URL, STORAGE_DATABASE_URL, STORAGE_URL");
  process.exit(1);
}
console.log("Using connection from env (masked):", process.env.POSTGRES_URL.replace(/:([^:@]+)@/, ":****@"));

const rawDdl = fs.readFileSync(schemaPath, "utf8");

// 1. Strip line comments first (-- ...) so they don't interfere with splitting.
// 2. Split on semicolons that aren't inside dollar-quoted bodies ($$ ... $$).
//    This matters for CREATE FUNCTION ... AS $$ BEGIN ...; END; $$.
const noLineComments = rawDdl
  .split("\n")
  .map(line => {
    const idx = line.indexOf("--");
    return idx === -1 ? line : line.slice(0, idx);
  })
  .join("\n");

const statements = [];
let buf = "";
let inDollarQuote = false;
for (let i = 0; i < noLineComments.length; i++) {
  const c = noLineComments[i];
  const c2 = noLineComments.slice(i, i + 2);
  if (c2 === "$$") {
    inDollarQuote = !inDollarQuote;
    buf += "$$";
    i++;
    continue;
  }
  if (c === ";" && !inDollarQuote) {
    const trimmed = buf.trim();
    if (trimmed) statements.push(trimmed);
    buf = "";
    continue;
  }
  buf += c;
}
if (buf.trim()) statements.push(buf.trim());

console.log(`Running ${statements.length} statements against ${process.env.POSTGRES_URL.split("@")[1]?.split("/")[0] ?? "?"}`);

for (const stmt of statements) {
  try {
    await sql.query(stmt);
    console.log("  ✓", stmt.slice(0, 80).replace(/\s+/g, " "));
  } catch (e) {
    console.error("  ✗", stmt.slice(0, 80).replace(/\s+/g, " "));
    console.error("    ", e.message);
    process.exit(1);
  }
}
console.log("Done.");
