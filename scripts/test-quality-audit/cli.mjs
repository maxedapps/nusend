#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  REPO_ROOT,
  extractInventory,
  hashFile,
  loadAudit,
  renderMarkdown,
  validateAudit,
  validateInventory,
} from "./core.mjs";

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: audit <import|validate|compare-report|render> ...");
  process.exitCode = 2;
}
function parse(args) {
  const [command, ...rest] = args;
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const value = rest[i];
    if (!value.startsWith("--")) throw new Error(`unexpected argument ${value}`);
    const key = value.slice(2);
    if (["strict", "write", "check"].includes(key)) options[key] = true;
    else {
      if (!rest[i + 1] || rest[i + 1].startsWith("--"))
        throw new Error(`missing value for --${key}`);
      options[key] = rest[++i];
    }
  }
  return { command, options };
}
async function main() {
  const { command, options } = parse(process.argv.slice(2));
  if (command === "validate") {
    if (!options.manifest) return usage("validate requires --manifest");
    const result = await validateAudit(options.manifest, { strict: options.strict });
    if (result.errors.length) {
      for (const error of result.errors) console.error(`ERROR: ${error}`);
      process.exitCode = 1;
    } else
      console.log(
        `Audit validation passed (${options.strict ? "strict" : "non-strict"}; baseline ${result.baseline.tests.length}${result.finalInventory ? `, final ${result.finalInventory.tests.length}` : ""}).`,
      );
  } else if (command === "render") {
    if (!options.manifest || !options.out || options.write === options.check)
      return usage("render requires --manifest, --out, and exactly one of --write/--check");
    const loaded = await loadAudit(options.manifest);
    const rendered = renderMarkdown(loaded.manifest, loaded.baseline, loaded.finalInventory);
    const out = path.resolve(options.out);
    if (options.write) {
      await writeFile(out, rendered);
      console.log(`Wrote ${options.out}.`);
    } else {
      let current = "";
      try {
        current = await readFile(out, "utf8");
      } catch {}
      if (current !== rendered) throw new Error(`generated view is stale: ${options.out}`);
      console.log(`Generated view is current: ${options.out}.`);
    }
  } else if (command === "compare-report") {
    if (!["baseline", "final"].includes(options.snapshot) || !options.report || !options.inventory)
      return usage("compare-report requires --snapshot baseline|final --report --inventory");
    const inventory = JSON.parse(await readFile(options.inventory, "utf8"));
    const inventoryErrors = validateInventory(inventory, "comparison inventory", options.snapshot);
    if (inventoryErrors.length) throw new Error(inventoryErrors.join("; "));
    const reportBytes = await readFile(options.report);
    const report = JSON.parse(reportBytes);
    const extracted = await extractInventory(report, {
      snapshot: options.snapshot,
      reportSha256: await hashFile(options.report),
      provenance: inventory.report,
    });
    const count = (tests) => {
      const result = new Map();
      for (const test of tests) {
        const tuple = JSON.stringify(test.tuple);
        result.set(tuple, (result.get(tuple) ?? 0) + 1);
      }
      return result;
    };
    const expected = count(inventory.tests);
    const actual = count(extracted.tests);
    const deltas = [...new Set([...expected.keys(), ...actual.keys()])].sort().flatMap((tuple) => {
      const difference = (actual.get(tuple) ?? 0) - (expected.get(tuple) ?? 0);
      return difference === 0 ? [] : [`${tuple}: ${difference > 0 ? "+" : ""}${difference}`];
    });
    const errors = [];
    if (deltas.length) errors.push(`identity multiset differs (${deltas.join(", ")})`);
    if (extracted.report.success !== inventory.report.success)
      errors.push(
        `report success differs: expected ${inventory.report.success}, received ${extracted.report.success}`,
      );
    if (extracted.report.declaredTests !== inventory.report.declaredTests)
      errors.push(
        `test total differs: expected ${inventory.report.declaredTests}, received ${extracted.report.declaredTests}`,
      );
    if (extracted.report.declaredFiles !== inventory.report.declaredFiles)
      errors.push(
        `file total differs: expected ${inventory.report.declaredFiles}, received ${extracted.report.declaredFiles}`,
      );
    if (errors.length) throw new Error(errors.join("; "));
    console.log(
      `Report matches ${options.inventory}: success=${extracted.report.success}, files=${extracted.report.declaredFiles}, tests=${extracted.report.declaredTests}, identity-deltas=0.`,
    );
  } else if (command === "import") {
    if (!["baseline", "final"].includes(options.snapshot) || !options.report || !options.inventory)
      return usage("import requires --snapshot baseline|final --report --inventory");
    const bytes = await readFile(options.report);
    const report = JSON.parse(bytes);
    const packageJson = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
    const vitestPackage = JSON.parse(
      await readFile(path.join(REPO_ROOT, "node_modules/vitest/package.json"), "utf8"),
    );
    const absoluteReport = path.resolve(options.report);
    const relativeReport = path.relative(REPO_ROOT, absoluteReport).split(path.sep).join("/");
    const portableReportPath =
      relativeReport && !relativeReport.startsWith("../")
        ? relativeReport
        : `<external>/${path.basename(absoluteReport)}`;
    const inventory = await extractInventory(report, {
      snapshot: options.snapshot,
      reportSha256: await hashFile(options.report),
      provenance: {
        command: `pnpm exec vitest run --reporter=json --outputFile=${portableReportPath}`,
        collectedAt: Number.isFinite(report.startTime)
          ? new Date(report.startTime).toISOString()
          : "report-date-unavailable",
        vitestVersion: vitestPackage.version,
        nodeVersion: process.version,
        pnpmVersion: String(packageJson.packageManager).replace(/^pnpm@/u, ""),
        localPath: portableReportPath,
      },
    });
    await writeFile(options.inventory, `${JSON.stringify(inventory, null, 2)}\n`);
    console.log(
      `Imported ${inventory.tests.length} identities to ${options.inventory}; classifications remain unresolved.`,
    );
  } else usage(`unknown command ${JSON.stringify(command)}`);
}
main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
