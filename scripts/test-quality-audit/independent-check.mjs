#!/usr/bin/env node
// Intentionally independent: Node built-ins only; do not import audit core.
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const mode = option("--mode");
const manifestArg = option("--manifest");
if (!["baseline", "final"].includes(mode) || !manifestArg) {
  console.error("Usage: independent-check --mode baseline|final --manifest <path>");
  process.exit(2);
}
const root = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."));
const manifestPath = path.resolve(manifestArg);
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes);
const ref = manifest.inventories?.[mode];
if (!ref) {
  console.error(`ERROR: ${mode} inventory reference is absent`);
  process.exit(1);
}
const inventoryPath = path.resolve(root, ref.path);
const relative = path.relative(root, inventoryPath);
if (relative.startsWith("..") || path.isAbsolute(relative)) {
  console.error("ERROR: inventory path escapes repository");
  process.exit(1);
}
const inventoryBytes = await readFile(inventoryPath);
const inventory = JSON.parse(inventoryBytes);
const errors = [];
if (hash(inventoryBytes) !== ref.sha256) errors.push(`committed ${mode} inventory hash differs`);
const expectedCounts = new Map();
const actualCounts = new Map();
const add = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
for (const [index, test] of inventory.tests.entries()) {
  const tuple = ["vitest-json-v1", test.file, test.fullName, test.occurrence];
  const tupleText = JSON.stringify(tuple);
  add(expectedCounts, tupleText);
  if (JSON.stringify(test.tuple) !== tupleText) errors.push(`tests[${index}] tuple fields differ`);
  const id = hash(tupleText);
  if (id !== test.id) errors.push(`tests[${index}] computed ID differs: ${test.id}`);
}
if (inventory.report.declaredTests !== inventory.tests.length)
  errors.push(
    `declared total ${inventory.report.declaredTests} differs from ${inventory.tests.length}`,
  );
if (mode === "baseline")
  for (const edge of manifest.dispositions ?? [])
    for (const id of edge.from ?? []) {
      const test = inventory.tests.find((item) => item.id === id);
      if (test && hash(JSON.stringify(test.tuple)) === id)
        add(actualCounts, JSON.stringify(test.tuple));
    }
if (mode === "final") {
  for (const edge of manifest.dispositions ?? [])
    for (const id of edge.to ?? []) {
      const test = inventory.tests.find((item) => item.id === id);
      if (test && hash(JSON.stringify(test.tuple)) === id)
        add(actualCounts, JSON.stringify(test.tuple));
    }
  for (const addition of manifest.additions ?? [])
    for (const id of addition.to ?? []) {
      const test = inventory.tests.find((item) => item.id === id);
      if (test && hash(JSON.stringify(test.tuple)) === id)
        add(actualCounts, JSON.stringify(test.tuple));
    }
}
const keys = [...new Set([...expectedCounts.keys(), ...actualCounts.keys()])].sort();
const deltas = keys.flatMap((key) => {
  const expected = expectedCounts.get(key) ?? 0;
  const actual = actualCounts.get(key) ?? 0;
  return expected === actual
    ? []
    : [
        {
          tuple: key,
          missing: Math.max(0, expected - actual),
          extra: Math.max(0, actual - expected),
          multiplicityDelta: actual - expected,
        },
      ];
});
if (deltas.length) errors.push(`identity deltas: ${JSON.stringify(deltas)}`);
const multisetHash = hash(
  JSON.stringify([...expectedCounts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
);
console.log(
  `independent-check script-sha256=${hash(await readFile(fileURLToPath(import.meta.url)))}`,
);
console.log(
  `manifest-sha256=${hash(manifestBytes)} inventory-sha256=${hash(inventoryBytes)} multiset-sha256=${multisetHash}`,
);
console.log(
  `mode=${mode} tests=${inventory.tests.length} missing=${deltas.reduce((n, d) => n + d.missing, 0)} extra=${deltas.reduce((n, d) => n + d.extra, 0)} multiplicity-deltas=${deltas.length}`,
);
if (errors.length) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  process.exitCode = 1;
} else console.log("Independent identity check passed.");
