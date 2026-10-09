#!/usr/bin/env node
/**
 * Static preflight for manual releases. No DB connection, no mutations.
 * Blocks ambiguous migration ordering and obvious transactional hazards.
 */
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const dir = resolve(process.cwd(), "infrastructure/postgres");
const files = (await readdir(dir))
  .filter((f) => /^\\d+.*\\.sql$/.test(f))
  .sort();

const byOrdinal = new Map();
const findings = [];

for (const filename of files) {
  const ordinal = filename.match(/^(\\d+)/)?.[1] ?? "";
  const peers = byOrdinal.get(ordinal) ?? [];
  peers.push(filename);
  byOrdinal.set(ordinal, peers);

  const sql = await readFile(resolve(dir, filename), "utf8");
  if (!sql.trim()) {
    findings.push({ severity: "BLOCK", filename, message: "empty migration" });
  }
  if (/\\bDROP\\s+SCHEMA\\s+public\\b/i.test(sql)) {
    findings.push({ severity: "BLOCK", filename, message: "DROP SCHEMA public" });
  }
  if (/\\bDISABLE\\s+ROW\\s+LEVEL\\s+SECURITY\\b/i.test(sql)) {
    findings.push({ severity: "BLOCK", filename, message: "RLS explicitly disabled" });
  }
}

for (const [ordinal, peers] of byOrdinal) {
  if (peers.length > 1) {
    findings.push({
      severity: "BLOCK",
      ordinal,
      files: peers,
      message: "duplicate numeric migration prefix: ordering is ambiguous"
    });
  }
}

const summary = {
  checked: files.length,
  blocked: findings.filter((f) => f.severity === "BLOCK").length,
  findings
};
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exitCode = summary.blocked ? 1 : 0;
