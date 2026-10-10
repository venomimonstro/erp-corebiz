#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
const findings = [];

function add(severity, file, message) {
  findings.push({
    severity,
    file: file ? relative(ROOT, file).split(sep).join("/") : null,
    message
  });
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const output = [];

  for (const entry of entries) {
    if (
      entry.name === "node_modules" ||
      entry.name === ".next" ||
      entry.name === "dist" ||
      entry.name === "coverage"
    ) {
      continue;
    }

    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      output.push(...(await walk(path)));
    } else {
      output.push(path);
    }
  }

  return output;
}

function normalize(path) {
  return relative(ROOT, path).split(sep).join("/");
}

function inspectAppModule(file, source) {
  const imports = Array.from(
    source.matchAll(/^import\s+\{\s*([A-Za-z0-9_]+)\s*\}\s+from\s+/gm),
    (match) => match[1]
  );
  const duplicateImports = imports.filter(
    (name, index) => imports.indexOf(name) !== index
  );

  for (const name of new Set(duplicateImports)) {
    add("BLOCK", file, "duplicate AppModule import: " + name);
  }

  const importsArray = source.match(/imports\s*:\s*\[([\s\S]*?)\]\s*,\s*providers/);
  if (!importsArray) {
    add("BLOCK", file, "AppModule imports array could not be inspected");
    return;
  }

  const names = Array.from(
    importsArray[1].matchAll(/\b([A-Za-z][A-Za-z0-9_]*Module)\b/g),
    (match) => match[1]
  );
  const duplicates = names.filter(
    (name, index) => names.indexOf(name) !== index
  );

  for (const name of new Set(duplicates)) {
    add("BLOCK", file, "duplicate module in AppModule imports: " + name);
  }
}

function inspectController(file, source) {
  if (/DatabaseService/.test(source)) {
    add(
      "BLOCK",
      file,
      "controller imports/uses DatabaseService; controllers must call application/domain services"
    );
  }
  if (/\bfrom\s+["']pg["']/.test(source)) {
    add(
      "BLOCK",
      file,
      "controller imports pg directly"
    );
  }

  const publicMutations = Array.from(
    source.matchAll(
      /@Public\(\)[\s\S]{0,240}?@(Post|Put|Patch|Delete)\(([^\n]*)/g
    )
  );

  for (const match of publicMutations) {
    add(
      "WARN",
      file,
      "public mutating endpoint requires explicit rate-limit/idempotency review: @" +
        match[1] +
        "(" +
        match[2].trim() +
        ")"
    );
  }
}

function inspectWeb(file, source) {
  if (/dangerouslySetInnerHTML/.test(source)) {
    add(
      "BLOCK",
      file,
      "dangerouslySetInnerHTML is forbidden in product UI/public renderer"
    );
  }

  const exposedSecrets = Array.from(
    source.matchAll(
      /NEXT_PUBLIC_[A-Z0-9_]*(?:SECRET|PASSWORD|PRIVATE_KEY|API_KEY|TOKEN)[A-Z0-9_]*/g
    ),
    (match) => match[0]
  );

  for (const name of new Set(exposedSecrets)) {
    add(
      "BLOCK",
      file,
      "sensitive environment variable exposed to browser: " + name
    );
  }

  const localSensitive = Array.from(
    source.matchAll(
      /localStorage\.setItem\(\s*["'][^"']*(?:token|secret|password|session|api[_-]?key)[^"']*["']/gi
    )
  );

  if (localSensitive.length) {
    add(
      "BLOCK",
      file,
      "sensitive credential/session-like value persisted to localStorage"
    );
  }
}

function inspectBusinessBoundaries(file, source) {
  const path = normalize(file);

  if (
    /\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+inventory_balance\b/i.test(
      source
    ) &&
    !path.includes("/business/inventory/") &&
    !path.includes("/business/wms/")
  ) {
    add(
      "BLOCK",
      file,
      "inventory_balance mutation outside Inventory/WMS bounded contexts"
    );
  }

  if (
    /\bINSERT\s+INTO\s+accounting_entry\b/i.test(source) &&
    !path.includes("/business/accounting/")
  ) {
    add(
      "BLOCK",
      file,
      "accounting_entry creation outside Accounting bounded context"
    );
  }

  if (
    /\bUPDATE\s+accounting_entry\b/i.test(source) &&
    !path.includes("/business/accounting/")
  ) {
    add(
      "BLOCK",
      file,
      "accounting_entry mutation outside Accounting bounded context"
    );
  }
}

export async function inspectSource(root = ROOT) {
  findings.length = 0;

  const apiRoot = resolve(root, "apps/api/src");
  const webRoot = resolve(root, "apps/web");
  const appModule = resolve(apiRoot, "app.module.ts");

  const [apiFiles, webFiles, appSource] = await Promise.all([
    walk(apiRoot),
    walk(webRoot),
    readFile(appModule, "utf8")
  ]);

  inspectAppModule(appModule, appSource);

  for (const file of apiFiles) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const source = await readFile(file, "utf8");

    if (file.endsWith(".controller.ts")) {
      inspectController(file, source);
    }

    inspectBusinessBoundaries(file, source);

    if (/\bTODO\b|\bFIXME\b/.test(source)) {
      add("WARN", file, "TODO/FIXME remains in API source");
    }
  }

  for (const file of webFiles) {
    if (!/\.(ts|tsx|js|jsx)$/.test(file)) continue;
    const source = await readFile(file, "utf8");
    inspectWeb(file, source);
  }

  const workflows = resolve(root, ".github/workflows");
  try {
    const workflowFiles = await readdir(workflows);
    if (workflowFiles.some((name) => /\.ya?ml$/i.test(name))) {
      add(
        "BLOCK",
        workflows,
        "GitHub Actions workflows found although this repository is operated without CI/Actions"
      );
    }
  } catch {
    // No workflow directory is expected for this repository.
  }

  return {
    checkedApiFiles: apiFiles.filter((file) => /\.(ts|tsx)$/.test(file)).length,
    checkedWebFiles: webFiles.filter((file) => /\.(ts|tsx|js|jsx)$/.test(file)).length,
    blocked: findings.filter((item) => item.severity === "BLOCK").length,
    warnings: findings.filter((item) => item.severity === "WARN").length,
    findings: [...findings]
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const report = await inspectSource(ROOT);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    process.exitCode = report.blocked > 0 ? 1 : 0;
  } catch (error) {
    process.stderr.write(
      "[stability-preflight] BLOCKED: " +
        (error instanceof Error ? error.stack ?? error.message : String(error)) +
        "\n"
    );
    process.exitCode = 1;
  }
}
