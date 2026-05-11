#!/usr/bin/env node
// Run schema.sql against POSTGRES_URL.
// Usage: npm run db:migrate
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "@vercel/postgres";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, "..", "lib", "db", "schema.sql");

if (!process.env.POSTGRES_URL) {
  console.error("POSTGRES_URL env var is required");
  process.exit(1);
}

const ddl = fs.readFileSync(schemaPath, "utf8");
const statements = ddl
  .split(/;\s*\n/g)
  .map(s => s.trim())
  .filter(s => s.length && !s.startsWith("--"));

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
