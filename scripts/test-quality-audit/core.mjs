import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = "test-audit-v1";
export const IDENTITY_ALGORITHM = "sha256-json-tuple-v1";
export const VIEW_VERSION = "test-audit-markdown-v2";
export const REPO_ROOT = await realpath(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
);
const identityTag = "vitest-json-v1";
const shaPattern = /^[0-9a-f]{64}$/;
const genericPhrases = [
  "full suite passed",
  "test suite passed",
  "retain existing coverage",
  "coverage remains green",
  "final full-suite pass.",
  "new distinct plan invariant, stronger replacement, or split attack/failure mode.",
  "baseline pass; see final-key disposition/reconciliation below.",
  "observable contract:",
  "the endpoint distinguishes missing identity, insufficient key scope, and authorized ownership",
  "the stated malformed or out-of-policy input is rejected at its validation boundary",
  "the named adversarial audit-tool branch protects exact identity, topology, quality validation",
  "admit this independently reported branch after the focused t29 replacement passed",
  "defect/mixed-cause rows prove two-cycle no-resend",
  "the read projection applies the requested ordering/filter/page semantics",
  "the operation commits the intended resource transition and returns values",
  "the production behavior described by `",
  "reporter branch `",
  "its assertions check the branch-specific output/state",
  "this evidence is limited to the `",
  "input/state and does not establish neighboring branches",
  "distinct inspected assertion branch:",
  "the supplied `",
  "case is refused at the production boundary, with its exact error/status",
  "mapping is exercised directly and its exact normalized output or error category is asserted",
  "the production path reports `",
  "with the asserted status/category/detail.",
  "admitted after baseline because the `",
  "branch protects this distinct failure/input/state; adjacent records exercise different values or boundaries",
  "produces the asserted request/response and durable rows without an extra resource.",
  "is prevented, as shown by the asserted unchanged state or zero call count.",
  "scenario preserves the asserted state across the production operation.",
  "with the asserted stream, fields, ordering, and secret-exclusion behavior.",
  "selection path is exercised and its exact path/request/output is asserted.",
  "reaches the production branch and yields the asserted normalized value.",
  "applies the asserted query/order/page shape and returns the exact projected fields.",
  "and assertions inspect the exact response/value rather than only mock interaction.",
  "requirement fails closed or succeeds only with the asserted prerequisite.",
  "is selected only under the stated input and returns the asserted fixed result.",
  "yields the asserted parsed configuration values and optional/default state.",
  "condition is established by the exact asserted output and side effects.",
  "returns 409 and leaves the original mailing response unchanged.",
];

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const identityTuple = (file, fullName, occurrence) => [
  identityTag,
  file,
  fullName,
  occurrence,
];
export const identityId = (file, fullName, occurrence) =>
  sha256(JSON.stringify(identityTuple(file, fullName, occurrence)));

function fail(message) {
  throw new Error(message);
}
function posixRelative(value) {
  return value.split(path.sep).join("/");
}
function compareExact(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel !== "" && !rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel);
}

export async function reporterPathToRelative(reporterPath, root = REPO_ROOT) {
  if (typeof reporterPath !== "string" || !path.isAbsolute(reporterPath))
    fail(`report path must be absolute: ${JSON.stringify(reporterPath)}`);
  if (reporterPath.normalize("NFC") !== reporterPath)
    fail(`ambiguous Unicode normalization in report path: ${JSON.stringify(reporterPath)}`);
  if (reporterPath.split(/[\\/]/u).includes(".."))
    fail(`report path contains traversal: ${JSON.stringify(reporterPath)}`);
  const lexical = path.resolve(reporterPath);
  if (!isInside(root, lexical))
    fail(`report path is outside repository: ${JSON.stringify(reporterPath)}`);
  let actual;
  try {
    actual = await realpath(lexical);
  } catch (error) {
    fail(
      `report path does not resolve: ${JSON.stringify(reporterPath)} (${error.code ?? "error"})`,
    );
  }
  if (!isInside(root, actual))
    fail(`report path escapes repository through symlink: ${JSON.stringify(reporterPath)}`);
  if (actual !== lexical)
    fail(`report path is a symlink or has ambiguous case: ${JSON.stringify(reporterPath)}`);
  const info = await lstat(lexical);
  if (!info.isFile()) fail(`report path is not a file: ${JSON.stringify(reporterPath)}`);
  const relative = posixRelative(path.relative(root, lexical));
  if (!relative || relative.startsWith("../") || path.posix.isAbsolute(relative))
    fail(`invalid repository-relative report path: ${JSON.stringify(relative)}`);
  return relative;
}

export async function extractInventory(
  report,
  { snapshot, reportSha256, provenance, root = REPO_ROOT } = {},
) {
  if (!report || !Array.isArray(report.testResults)) fail("report.testResults must be an array");
  if (!["baseline", "final"].includes(snapshot))
    fail(`snapshot must be baseline or final: ${JSON.stringify(snapshot)}`);
  if (typeof report.success !== "boolean") fail("report.success must be a boolean");
  if (!shaPattern.test(reportSha256 ?? ""))
    fail("raw report SHA-256 must be 64 lowercase hexadecimal characters");
  if (
    !provenance?.command ||
    !provenance?.collectedAt ||
    !provenance?.vitestVersion ||
    !provenance?.nodeVersion ||
    !provenance?.pnpmVersion
  )
    fail("raw report provenance is incomplete");
  const entries = [];
  const occurrences = new Map();
  const casePaths = new Map();
  for (const fileResult of report.testResults) {
    const file = await reporterPathToRelative(fileResult.name, root);
    const folded = file.toLocaleLowerCase("en-US");
    const prior = casePaths.get(folded);
    if (prior)
      fail(
        prior === file
          ? `duplicate normalized report file: ${JSON.stringify(file)}`
          : `case-only report path collision: ${JSON.stringify(prior)} and ${JSON.stringify(file)}`,
      );
    casePaths.set(folded, file);
    if (!Array.isArray(fileResult.assertionResults))
      fail(`assertionResults must be an array for ${file}`);
    for (const assertion of fileResult.assertionResults) {
      if (typeof assertion.fullName !== "string") fail(`fullName must be a string in ${file}`);
      const key = JSON.stringify([file, assertion.fullName]);
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      entries.push({
        id: identityId(file, assertion.fullName, occurrence),
        tuple: identityTuple(file, assertion.fullName, occurrence),
        file,
        fullName: assertion.fullName,
        occurrence,
      });
    }
  }
  if (Number.isInteger(report.numTotalTests) && report.numTotalTests !== entries.length)
    fail(`report declared ${report.numTotalTests} tests but contains ${entries.length} assertions`);
  entries.sort(
    (a, b) =>
      compareExact(a.file, b.file) ||
      compareExact(a.fullName, b.fullName) ||
      a.occurrence - b.occurrence,
  );
  return {
    schemaVersion: SCHEMA_VERSION,
    snapshot,
    identityAlgorithm: IDENTITY_ALGORITHM,
    report: {
      ...provenance,
      sha256: reportSha256,
      success: report.success,
      declaredFiles: casePaths.size,
      declaredTests: entries.length,
    },
    tests: entries,
  };
}

export function validateInventory(inventory, label = "inventory", expectedSnapshot) {
  const errors = [];
  if (inventory?.schemaVersion !== SCHEMA_VERSION)
    errors.push(`${label}: unsupported schemaVersion`);
  if (inventory?.identityAlgorithm !== IDENTITY_ALGORITHM)
    errors.push(`${label}: unsupported identityAlgorithm`);
  if (!["baseline", "final"].includes(inventory?.snapshot))
    errors.push(`${label}: snapshot must be baseline or final`);
  if (expectedSnapshot && inventory?.snapshot !== expectedSnapshot)
    errors.push(
      `${label}: snapshot ${JSON.stringify(inventory?.snapshot)} must be ${expectedSnapshot}`,
    );
  if (!shaPattern.test(inventory?.report?.sha256 ?? ""))
    errors.push(`${label}: malformed raw report hash`);
  for (const key of ["command", "collectedAt", "vitestVersion", "nodeVersion", "pnpmVersion"])
    if (!inventory?.report?.[key]) errors.push(`${label}: missing report provenance ${key}`);
  if (typeof inventory?.report?.success !== "boolean")
    errors.push(`${label}: report success must be boolean`);
  if (!Array.isArray(inventory?.tests)) return [...errors, `${label}: tests must be an array`];
  if (inventory.report?.declaredTests !== inventory.tests.length)
    errors.push(
      `${label}: declared test total ${inventory.report?.declaredTests} differs from ${inventory.tests.length}`,
    );
  const ids = new Set();
  const identities = new Set();
  const occurrences = new Map();
  const casePaths = new Map();
  const uniqueFiles = new Set();
  for (const [index, test] of inventory.tests.entries()) {
    const at = `${label}.tests[${index}]`;
    if (!Array.isArray(test.tuple) || test.tuple.length !== 4) {
      errors.push(`${at}: invalid identity tuple`);
      continue;
    }
    const [tag, file, fullName, occurrence] = test.tuple;
    if (
      tag !== identityTag ||
      test.file !== file ||
      test.fullName !== fullName ||
      test.occurrence !== occurrence
    )
      errors.push(`${at}: tuple fields differ`);
    if (
      typeof file !== "string" ||
      !file ||
      path.posix.isAbsolute(file) ||
      file.split("/").includes("..") ||
      file.normalize("NFC") !== file ||
      file.includes("\\")
    )
      errors.push(`${at}: invalid portable path`);
    if (typeof fullName !== "string" || !Number.isInteger(occurrence) || occurrence < 0)
      errors.push(`${at}: invalid fullName or occurrence`);
    const expectedId =
      typeof file === "string" && typeof fullName === "string"
        ? identityId(file, fullName, occurrence)
        : "";
    if (test.id !== expectedId) errors.push(`${at}: computed ID differs (${test.id})`);
    if (ids.has(test.id)) errors.push(`${at}: duplicate ID ${test.id}`);
    ids.add(test.id);
    const identity = JSON.stringify([file, fullName, occurrence]);
    if (identities.has(identity)) errors.push(`${at}: duplicate identity tuple`);
    identities.add(identity);
    const occurrenceKey = JSON.stringify([file, fullName]);
    const expectedOccurrence = occurrences.get(occurrenceKey) ?? 0;
    if (occurrence !== expectedOccurrence)
      errors.push(
        `${at}: occurrence ${occurrence} is not contiguous expected ${expectedOccurrence}`,
      );
    occurrences.set(occurrenceKey, expectedOccurrence + 1);
    const folded = typeof file === "string" ? file.toLocaleLowerCase("en-US") : "";
    const prior = casePaths.get(folded);
    if (prior && prior !== file)
      errors.push(`${label}: case-only path collision ${prior} / ${file}`);
    casePaths.set(folded, file);
    if (typeof file === "string") uniqueFiles.add(file);
  }
  if (inventory.report?.declaredFiles !== uniqueFiles.size)
    errors.push(
      `${label}: declared file total ${inventory.report?.declaredFiles} differs from ${uniqueFiles.size} unique normalized files`,
    );
  return errors;
}

function recordQualityErrors(record, label, titleById, changed) {
  const errors = [];
  const required = ["invariant", "boundary", "limitation", "wiring", "evidence"];
  for (const field of required)
    if (typeof record[field] !== "string" || !record[field].trim())
      errors.push(`${label}: missing concrete ${field}`);
  const prose = [...required, "rationale"]
    .map((field) => record[field] ?? "")
    .join(" ")
    .toLowerCase();
  if (genericPhrases.some((phrase) => prose.includes(phrase)))
    errors.push(`${label}: generic blanket evidence is forbidden`);
  for (const id of [...(record.from ?? []), ...(record.to ?? [])])
    if ((record.invariant ?? "") === titleById.get(id))
      errors.push(`${label}: invariant copies reporter fullName for ${id}`);
  if (
    record.wiring &&
    (/\.test\.[cm]?[jt]sx?$/u.test(record.wiring) ||
      record.wiring.startsWith("scripts/test-quality-audit/fixtures/"))
  )
    errors.push(`${label}: production wiring points only to tests`);
  if (changed && (typeof record.rationale !== "string" || !record.rationale.trim()))
    errors.push(`${label}: changed edge requires replacement/removal rationale`);
  return errors;
}

export function validateManifestData(manifest, baseline, finalInventory, { strict = false } = {}) {
  const errors = [...validateInventory(baseline, "baseline inventory", "baseline")];
  if (finalInventory) errors.push(...validateInventory(finalInventory, "final inventory", "final"));
  if (manifest?.schemaVersion !== SCHEMA_VERSION)
    errors.push("manifest: unsupported schemaVersion");
  if (manifest?.identityAlgorithm !== IDENTITY_ALGORITHM)
    errors.push("manifest: unsupported identityAlgorithm");
  for (const [name, inventory] of [
    ["baseline", baseline],
    ["final", finalInventory],
  ]) {
    if (!inventory) continue;
    const recorded = manifest.reports?.[name];
    if (!recorded) errors.push(`manifest: missing ${name} report metadata`);
    else
      for (const field of [
        "sha256",
        "command",
        "collectedAt",
        "vitestVersion",
        "nodeVersion",
        "pnpmVersion",
        "success",
        "declaredFiles",
        "declaredTests",
      ])
        if (recorded[field] !== inventory.report[field])
          errors.push(`manifest reports.${name}.${field} differs from inventory`);
  }
  if (!Array.isArray(manifest?.dispositions) || !Array.isArray(manifest?.additions))
    return [...errors, "manifest: dispositions and additions must be arrays"];
  const baselineById = new Map(baseline.tests.map((test) => [test.id, test]));
  const finalById = new Map((finalInventory?.tests ?? []).map((test) => [test.id, test]));
  const titleById = new Map(
    [...baselineById, ...finalById].map(([id, test]) => [id, test.fullName]),
  );
  const sources = new Map();
  const targets = new Map();
  const add = (map, id, label) => {
    const labels = map.get(id) ?? [];
    labels.push(label);
    map.set(id, labels);
  };
  for (const [index, edge] of manifest.dispositions.entries()) {
    const label = `dispositions[${index}]${edge?.id ? ` ${edge.id}` : ""}`;
    const from = Array.isArray(edge?.from) ? edge.from : [];
    const to = Array.isArray(edge?.to) ? edge.to : [];
    for (const id of from) {
      if (!baselineById.has(id)) errors.push(`${label}: dangling baseline ID ${id}`);
      add(sources, id, label);
    }
    for (const id of to) {
      if (!finalById.has(id)) errors.push(`${label}: dangling final ID ${id}`);
      add(targets, id, label);
    }
    const operation = edge?.operation;
    if (operation === "retain" && (from.length !== 1 || to.length !== 1 || from[0] !== to[0]))
      errors.push(`${label}: retain requires one unchanged identity`);
    else if (operation === "rewrite" && (from.length !== 1 || to.length !== 1 || from[0] === to[0]))
      errors.push(`${label}: rewrite requires one changed source and target`);
    else if (operation === "merge" && (from.length < 2 || to.length !== 1))
      errors.push(`${label}: merge requires multiple sources and one target`);
    else if (operation === "delete" && (from.length !== 1 || to.length !== 0))
      errors.push(`${label}: delete requires one source and no target`);
    else if (operation === "unresolved") {
      if (from.length !== 1 || to.length !== 0)
        errors.push(`${label}: unresolved requires one source and no target`);
      if (strict) errors.push(`${label}: classification unresolved`);
    } else if (!["retain", "rewrite", "merge", "delete", "unresolved"].includes(operation))
      errors.push(`${label}: invalid operation ${JSON.stringify(operation)}`);
    if (strict && operation !== "unresolved")
      errors.push(...recordQualityErrors(edge, label, titleById, operation !== "retain"));
  }
  for (const [index, addition] of manifest.additions.entries()) {
    const label = `additions[${index}]${addition?.id ? ` ${addition.id}` : ""}`;
    const to = Array.isArray(addition?.to) ? addition.to : [];
    if (to.length !== 1) errors.push(`${label}: addition requires exactly one final target`);
    for (const id of to) {
      if (!finalById.has(id)) errors.push(`${label}: dangling final ID ${id}`);
      add(targets, id, label);
    }
    if (strict) errors.push(...recordQualityErrors(addition, label, titleById, true));
  }
  for (const id of baselineById.keys()) {
    const count = sources.get(id)?.length ?? 0;
    if (count !== 1)
      errors.push(`baseline ID ${id}: expected exactly one disposition source, found ${count}`);
  }
  for (const [id, labels] of sources)
    if (labels.length > 1)
      errors.push(`baseline ID ${id}: overlapping source edges ${labels.join(", ")}`);
  for (const id of finalById.keys()) {
    const count = targets.get(id)?.length ?? 0;
    if (count !== 1)
      errors.push(
        `final ID ${id}: expected exactly one disposition target or addition, found ${count}`,
      );
  }
  for (const [id, labels] of targets)
    if (labels.length > 1)
      errors.push(`final ID ${id}: overlapping target admissions ${labels.join(", ")}`);
  if (strict && finalInventory) {
    const names = new Set();
    for (const test of finalInventory.tests) {
      const key = JSON.stringify([test.file, test.fullName]);
      if (names.has(key)) errors.push(`final duplicate name remains: ${key}`);
      names.add(key);
    }
  }
  if (strict && !finalInventory)
    errors.push("final topology unresolved: final inventory is absent");
  if (strict && (!Array.isArray(manifest.reviewBatches) || manifest.reviewBatches.length === 0))
    errors.push("review topology unresolved: reviewBatches are absent");
  if (strict)
    for (const [index, batch] of (manifest.reviewBatches ?? []).entries()) {
      const label = `reviewBatches[${index}]`;
      for (const field of ["reviewer", "date", "artifact", "artifactSha256", "workingReportSha256"])
        if (typeof batch?.[field] !== "string" || !batch[field].trim())
          errors.push(`${label}: missing ${field}`);
      for (const field of ["fullyRead", "partiallyRead", "skipped", "reviewRunIds"])
        if (!Array.isArray(batch?.[field])) errors.push(`${label}: ${field} must be an array`);
      if (batch?.artifactSha256 && !shaPattern.test(batch.artifactSha256))
        errors.push(`${label}: invalid artifactSha256`);
      if (batch?.workingReportSha256 && !shaPattern.test(batch.workingReportSha256))
        errors.push(`${label}: invalid workingReportSha256`);
    }
  for (const [index, mutation] of (manifest.mutations ?? []).entries()) {
    if (mutation.provenance === "historical" && mutation.status !== "imported-not-replayed")
      errors.push(`mutations[${index}]: historical evidence must be imported-not-replayed`);
  }
  const hosted = manifest.hostedStatus;
  if (strict) {
    if (hosted?.status === "passed") {
      for (const field of ["url", "runId", "headSha", "event", "conclusion", "date"])
        if (!hosted[field]) errors.push(`hostedStatus: passed claim missing ${field}`);
      try {
        const url = new URL(hosted.url);
        if (!["https:", "http:"].includes(url.protocol)) throw new Error();
      } catch {
        errors.push("hostedStatus: passed claim has invalid url");
      }
      if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(hosted.headSha ?? ""))
        errors.push("hostedStatus: passed claim has invalid headSha");
      if (hosted.conclusion !== "success")
        errors.push("hostedStatus: passed claim conclusion must be success");
      if (typeof hosted.runId !== "string" && typeof hosted.runId !== "number")
        errors.push("hostedStatus: passed claim has invalid runId");
      if (typeof hosted.event !== "string" || !hosted.event.trim())
        errors.push("hostedStatus: passed claim has invalid event");
      if (typeof hosted.date !== "string" || Number.isNaN(Date.parse(hosted.date)))
        errors.push("hostedStatus: passed claim has invalid date");
    } else if (hosted?.status !== "external-unvalidated") {
      errors.push("hostedStatus: expected external-unvalidated or complete passed claim");
    }
  }
  return errors;
}

export function escapeMarkdown(value) {
  return String(value)
    .replace(/\\/gu, "\\\\")
    .replace(/\r/gu, "\\r")
    .replace(/\n/gu, "\\n")
    .replace(/\t/gu, "\\t")
    .replace(
      // oxlint-disable-next-line no-control-regex -- Canonical audit names may contain raw controls; render every remaining C0/DEL/separator byte as a visible Unicode escape.
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/gu,
      (char) => `\\u${char.codePointAt(0).toString(16).padStart(4, "0")}`,
    )
    .replace(/\|/gu, "\\|");
}

function visibleList(value) {
  return escapeMarkdown(JSON.stringify(Array.isArray(value) ? value : []));
}

function renderSubstantiveRecords(lines, heading, records) {
  lines.push(
    "",
    `## ${heading}`,
    "",
    "| Record | Operation | From | To | Invariant / risk | Actual boundary | Limitation | Production wiring | Evidence | Changed-test rationale |",
    "|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const record of records)
    lines.push(
      `| ${escapeMarkdown(record.id ?? "")} | ${escapeMarkdown(record.operation ?? "addition")} | ${visibleList(record.from)} | ${visibleList(record.to)} | ${escapeMarkdown(record.invariant ?? "")} | ${escapeMarkdown(record.boundary ?? "")} | ${escapeMarkdown(record.limitation ?? "")} | ${escapeMarkdown(record.wiring ?? "")} | ${escapeMarkdown(record.evidence ?? "")} | ${escapeMarkdown(record.rationale ?? "")} |`,
    );
}

export function renderMarkdown(manifest, baseline, finalInventory) {
  const lines = [
    "<!-- GENERATED — DO NOT EDIT. Canonical identities remain in JSON. Run pnpm audit:render. -->",
    "# Test quality audit",
    "",
    `Schema: \`${manifest.schemaVersion}\` · View: \`${manifest.generatedView.version}\``,
    "",
    "## Status",
    "",
    finalInventory
      ? `Baseline ${baseline.tests.length}; final ${finalInventory.tests.length}.`
      : `Bootstrap inventory: ${baseline.tests.length} baseline tests; final topology unresolved.`,
  ];
  for (const [heading, inventory] of [
    ["Baseline identity index", baseline],
    ["Candidate-final identity index", finalInventory],
  ]) {
    if (!inventory) continue;
    lines.push(
      "",
      `## ${heading}`,
      "",
      "| ID | File | Exact reporter full name |",
      "|---|---|---|",
    );
    for (const test of inventory.tests)
      lines.push(
        `| \`${test.id}\` | \`${escapeMarkdown(test.file)}\` | ${escapeMarkdown(test.fullName)} |`,
      );
  }
  renderSubstantiveRecords(lines, "Baseline dispositions", manifest.dispositions ?? []);
  renderSubstantiveRecords(lines, "Candidate-final additions", manifest.additions ?? []);
  lines.push(
    "",
    "## Review batches",
    "",
    "| Reviewer / date | Artifact / SHA-256 | Working report SHA-256 | Fully read | Partially read | Skipped | Review/follow-up run IDs | Residual limits |",
    "|---|---|---|---|---|---|---|---|",
  );
  for (const batch of manifest.reviewBatches ?? [])
    lines.push(
      `| ${escapeMarkdown(batch.reviewer ?? "")} / ${escapeMarkdown(batch.date ?? "")} | ${escapeMarkdown(batch.artifact ?? "")} / ${escapeMarkdown(batch.artifactSha256 ?? "")} | ${escapeMarkdown(batch.workingReportSha256 ?? "")} | ${visibleList(batch.fullyRead)} | ${visibleList(batch.partiallyRead)} | ${visibleList(batch.skipped)} | ${visibleList(batch.reviewRunIds)} | ${escapeMarkdown(batch.residualLimits ?? "")} |`,
    );
  lines.push(
    "",
    "## Mutation evidence",
    "",
    "| Key | Provenance | Status | Final IDs | Repro hash | Command | Result / limitation |",
    "|---|---|---|---|---|---|---|",
  );
  for (const mutation of manifest.mutations ?? [])
    lines.push(
      `| ${escapeMarkdown(mutation.key ?? "")} | ${escapeMarkdown(mutation.provenance ?? "")} | ${escapeMarkdown(mutation.status ?? "")} | ${visibleList(mutation.finalIds)} | ${escapeMarkdown(mutation.reproSha256 ?? "")} | ${escapeMarkdown(mutation.command ?? "")} | ${escapeMarkdown(mutation.result ?? mutation.limitation ?? "")} |`,
    );
  return `${lines.join("\n")}\n`;
}

export async function loadAudit(manifestPath) {
  const manifestAbsolute = path.resolve(manifestPath);
  const manifest = JSON.parse(await readFile(manifestAbsolute, "utf8"));
  const baseDir = path.dirname(manifestAbsolute);
  const loadRef = async (reference, label) => {
    if (!reference) return undefined;
    const absolute = path.resolve(REPO_ROOT, reference.path);
    if (!isInside(REPO_ROOT, absolute)) fail(`${label} inventory path escapes repository`);
    const bytes = await readFile(absolute);
    if (reference.sha256 !== sha256(bytes))
      fail(`${label} committed inventory hash differs: ${reference.path}`);
    return JSON.parse(bytes);
  };
  return {
    manifest,
    baseline: await loadRef(manifest.inventories?.baseline, "baseline"),
    finalInventory: await loadRef(manifest.inventories?.final, "final"),
    manifestAbsolute,
    baseDir,
  };
}

export async function validateAudit(manifestPath, { strict = false, checkRender = true } = {}) {
  const loaded = await loadAudit(manifestPath);
  const errors = validateManifestData(loaded.manifest, loaded.baseline, loaded.finalInventory, {
    strict,
  });
  if (strict) {
    for (const [collection, records] of [
      ["dispositions", loaded.manifest.dispositions ?? []],
      ["additions", loaded.manifest.additions ?? []],
    ])
      for (const [index, record] of records.entries()) {
        if (record.operation === "unresolved") continue;
        const wiringPath = typeof record.wiring === "string" ? record.wiring.split("#", 1)[0] : "";
        if (!wiringPath || path.posix.isAbsolute(wiringPath) || wiringPath.includes("..")) continue;
        try {
          const absolute = await realpath(path.resolve(REPO_ROOT, wiringPath));
          if (!isInside(REPO_ROOT, absolute))
            errors.push(`${collection}[${index}]: production wiring escapes repository`);
        } catch {
          errors.push(`${collection}[${index}]: production wiring does not resolve: ${wiringPath}`);
        }
      }
  }
  if (checkRender && loaded.manifest.generatedView?.path) {
    const expected = renderMarkdown(loaded.manifest, loaded.baseline, loaded.finalInventory);
    const outputPath = path.resolve(REPO_ROOT, loaded.manifest.generatedView.path);
    try {
      if ((await readFile(outputPath, "utf8")) !== expected)
        errors.push(`generated view is stale: ${loaded.manifest.generatedView.path}`);
    } catch {
      errors.push(`generated view is missing: ${loaded.manifest.generatedView.path}`);
    }
  }
  return { ...loaded, errors };
}

export async function hashFile(file) {
  return sha256(await readFile(file));
}
export async function assertRawReportHash(inventory, reportPath) {
  const actual = await hashFile(reportPath);
  if (actual !== inventory.report.sha256)
    fail(`raw report hash differs: expected ${inventory.report.sha256}, received ${actual}`);
}
export async function ensureFile(pathname) {
  await stat(pathname);
  return pathname;
}
