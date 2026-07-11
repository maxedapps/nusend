import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import fixture from "./fixtures/vitest-identities.json" with { type: "json" };
import {
  IDENTITY_ALGORITHM,
  REPO_ROOT,
  SCHEMA_VERSION,
  VIEW_VERSION,
  assertRawReportHash,
  escapeMarkdown,
  extractInventory,
  identityId,
  identityTuple,
  renderMarkdown,
  reporterPathToRelative,
  sha256,
  validateAudit,
  validateInventory,
  validateManifestData,
} from "./core.mjs";
const temporary = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true })),
  );
});
const provenance = {
  command: "vitest run --reporter=json",
  collectedAt: "2026-07-10T00:00:00.000Z",
  vitestVersion: "4.1.9",
  nodeVersion: "v26.1.0",
  pnpmVersion: "11.9.0",
};
function inventory(snapshot, tests) {
  return {
    schemaVersion: SCHEMA_VERSION,
    snapshot,
    identityAlgorithm: IDENTITY_ALGORITHM,
    report: {
      sha256: "a".repeat(64),
      ...provenance,
      success: true,
      declaredFiles: 1,
      declaredTests: tests.length,
    },
    tests,
  };
}
function testEntry(file, fullName, occurrence = 0) {
  return {
    id: identityId(file, fullName, occurrence),
    tuple: identityTuple(file, fullName, occurrence),
    file,
    fullName,
    occurrence,
  };
}
function manifestFor(base, final, dispositions, additions = []) {
  return {
    schemaVersion: SCHEMA_VERSION,
    identityAlgorithm: IDENTITY_ALGORITHM,
    reports: { baseline: base.report, final: final?.report ?? null },
    dispositions,
    additions,
    reviewBatches: [
      {
        reviewer: "reviewer",
        date: "2026-07-11",
        artifact: ".progress/review.md",
        artifactSha256: "b".repeat(64),
        workingReportSha256: "c".repeat(64),
        fullyRead: ["scripts/test-quality-audit/core.mjs"],
        partiallyRead: [],
        skipped: [],
        reviewRunIds: ["review-run"],
        residualLimits: "Local evidence only.",
      },
    ],
    mutations: [],
    generatedView: { path: "unused.md", version: VIEW_VERSION },
    hostedStatus: { status: "external-unvalidated" },
  };
}
const quality = {
  invariant: "Identity tuples remain byte-exact across committed evidence.",
  boundary: "Portable JSON inventory validation.",
  limitation: "Does not assess test semantics.",
  wiring: "scripts/test-quality-audit/core.mjs#validateManifestData",
  evidence: "Focused adversarial audit-tool test.",
};

describe("test-quality audit tooling", () => {
  it("preserves exact control strings and duplicate multiplicity with deterministic occurrences and IDs", async () => {
    const assertions = [
      fixture.duplicateFullName,
      fixture.duplicateFullName,
      ...fixture.controlNames,
    ].map((fullName) => ({ fullName }));
    const report = {
      success: true,
      testResults: [{ name: new URL(import.meta.url).pathname, assertionResults: assertions }],
    };
    const imported = await extractInventory(report, {
      snapshot: "baseline",
      reportSha256: "b".repeat(64),
      provenance,
    });
    expect(imported.tests).toHaveLength(assertions.length);
    expect(
      imported.tests
        .filter((x) => x.fullName === fixture.duplicateFullName)
        .map((x) => x.occurrence),
    ).toEqual([0, 1]);
    for (const name of fixture.controlNames)
      expect(imported.tests.some((x) => x.fullName === name)).toBe(true);
    for (const entry of imported.tests) expect(entry.id).toBe(sha256(JSON.stringify(entry.tuple)));
    const outside = path.join(os.tmpdir(), "outside-audit.test.mjs");
    await writeFile(outside, "");
    temporary.push(outside);
    await expect(reporterPathToRelative(outside)).rejects.toThrow("outside repository");
    const target = await mkdtemp(path.join(os.tmpdir(), "audit-target-"));
    temporary.push(target);
    const targetFile = path.join(target, "test.mjs");
    await writeFile(targetFile, "");
    const link = path.join(REPO_ROOT, "scripts/test-quality-audit", `.escape-${process.pid}`);
    await symlink(targetFile, link);
    temporary.push(link);
    await expect(reporterPathToRelative(link)).rejects.toThrow(
      "escapes repository through symlink",
    );
    const traversal = `${REPO_ROOT}/scripts/test-quality-audit/fixtures/../core.test.mjs`;
    await expect(reporterPathToRelative(traversal)).rejects.toThrow("contains traversal");
    const decomposed = `${REPO_ROOT}/scripts/test-quality-audit/cafe\u0301.test.mjs`;
    await expect(reporterPathToRelative(decomposed)).rejects.toThrow(
      "ambiguous Unicode normalization",
    );
  });

  it("visibly escapes every required control and never relies on Markdown round-tripping", () => {
    const value = `\\\r\n\t\0\u0001\u2028\u2029`;
    const escaped = escapeMarkdown(value);
    expect(escaped).toBe("\\\\\\r\\n\\t\\u0000\\u0001\\u2028\\u2029");
    expect(escaped).not.toContain("\n");
    const base = inventory("baseline", [testEntry("a.ts", value)]);
    const manifest = manifestFor(base, undefined, [
      { id: "u", operation: "unresolved", from: [base.tests[0].id], to: [] },
    ]);
    expect(renderMarkdown(manifest, base)).toContain(escaped);
  });

  it("renders every substantive field, review topology, and mutation provenance with visible escaping", () => {
    const baselineEntry = testEntry("scripts/test-quality-audit/core.mjs", "baseline identity");
    const finalEntry = testEntry("scripts/test-quality-audit/core.mjs", "final identity");
    const base = inventory("baseline", [baselineEntry]);
    const final = inventory("final", [finalEntry]);
    const edge = {
      id: "rewrite-control",
      operation: "rewrite",
      from: [baselineEntry.id],
      to: [finalEntry.id],
      invariant: "fixed risk | control\nline",
      boundary: "actual boundary",
      limitation: "synthetic limitation",
      wiring: "scripts/test-quality-audit/core.mjs#renderMarkdown",
      evidence: "focused renderer assertion",
      rationale: "changed identity rationale",
    };
    const manifest = manifestFor(base, final, [edge]);
    manifest.additions = [{ id: "addition", to: [finalEntry.id], ...quality }];
    manifest.reviewBatches[0].partiallyRead = ["scripts/test-quality-audit/cli.mjs"];
    manifest.reviewBatches[0].skipped = ["live provider"];
    manifest.mutations = [
      {
        key: "privacy",
        provenance: "replayed",
        status: "passed",
        finalIds: [finalEntry.id],
        reproSha256: "d".repeat(64),
        command: "vitest -t mutation",
        result: "sentinel absent",
      },
    ];

    const rendered = renderMarkdown(manifest, base, final);
    for (const value of [
      "fixed risk \\| control\\nline",
      "actual boundary",
      "synthetic limitation",
      "scripts/test-quality-audit/core.mjs#renderMarkdown",
      "focused renderer assertion",
      "changed identity rationale",
      "Candidate-final additions",
      ".progress/review.md",
      "scripts/test-quality-audit/cli.mjs",
      "live provider",
      "review-run",
      "Local evidence only.",
      "privacy",
      "replayed",
      "vitest -t mutation",
      "sentinel absent",
    ])
      expect(rendered).toContain(value);
    expect(rendered).not.toContain("control\nline");
  });

  it("rejects incomplete strict review-batch metadata", () => {
    const entry = testEntry("scripts/test-quality-audit/core.mjs", "valid identity");
    const base = inventory("baseline", [entry]);
    const final = inventory("final", [entry]);
    const manifest = manifestFor(base, final, [
      { id: "retain-valid", operation: "retain", from: [entry.id], to: [entry.id], ...quality },
    ]);
    manifest.reviewBatches = [{ reviewer: "reviewer" }];

    expect(validateManifestData(manifest, base, final, { strict: true }).join("\n")).toMatch(
      /missing artifact|fullyRead must be an array|reviewRunIds must be an array/,
    );
  });

  it("accepts one complete strict ledger", () => {
    const entry = testEntry("scripts/test-quality-audit/core.mjs", "valid identity");
    const base = inventory("baseline", [entry]);
    const final = inventory("final", [entry]);
    const edge = {
      id: "retain-valid",
      operation: "retain",
      from: [entry.id],
      to: [entry.id],
      ...quality,
    };
    expect(
      validateManifestData(manifestFor(base, final, [edge]), base, final, { strict: true }),
    ).toEqual([]);
  });

  it.each([
    [
      "copied title and blanket evidence",
      (base, final) => [
        {
          id: "bad",
          operation: "retain",
          from: [base.tests[0].id],
          to: [final.tests[0].id],
          ...quality,
          invariant: base.tests[0].fullName,
          evidence: "Full suite passed",
        },
      ],
      /invariant copies|generic blanket/,
    ],
    [
      "orphan and overlap",
      (base, final) => [
        {
          id: "one",
          operation: "retain",
          from: [base.tests[0].id],
          to: [final.tests[0].id],
          ...quality,
        },
        {
          id: "two",
          operation: "delete",
          from: [base.tests[0].id],
          to: [],
          ...quality,
          rationale: "Removed as redundant.",
        },
        {
          id: "orphan",
          operation: "delete",
          from: ["f".repeat(64)],
          to: [],
          ...quality,
          rationale: "Removed.",
        },
      ],
      /dangling baseline ID|overlapping source/,
    ],
    [
      "orphan final identity",
      (base) => [
        {
          id: "orphan-final",
          operation: "rewrite",
          from: [base.tests[0].id],
          to: ["e".repeat(64)],
          ...quality,
          rationale: "Replacement identity was intentionally changed.",
        },
      ],
      /dangling final ID/,
    ],
  ])("rejects %s with record-specific diagnostics", (_name, build, diagnostic) => {
    const entry = testEntry("scripts/test-quality-audit/core.mjs", "reporter title");
    const base = inventory("baseline", [entry]);
    const final = inventory("final", [entry]);
    expect(
      validateManifestData(manifestFor(base, final, build(base, final)), base, final, {
        strict: true,
      }).join("\n"),
    ).toMatch(diagnostic);
  });

  it.each([
    [
      "retain",
      (base) => ({ operation: "retain", from: [base.tests[0].id], to: [] }),
      /retain requires one unchanged identity/,
    ],
    [
      "rewrite",
      (base) => ({ operation: "rewrite", from: [base.tests[0].id], to: [base.tests[0].id] }),
      /rewrite requires one changed source and target/,
    ],
    [
      "merge",
      (base, final) => ({ operation: "merge", from: [base.tests[0].id], to: [final.tests[0].id] }),
      /merge requires multiple sources and one target/,
    ],
    [
      "delete",
      (base, final) => ({ operation: "delete", from: [base.tests[0].id], to: [final.tests[0].id] }),
      /delete requires one source and no target/,
    ],
  ])("rejects invalid %s cardinality", (_operation, build, diagnostic) => {
    const entry = testEntry("scripts/test-quality-audit/core.mjs", "cardinality title");
    const base = inventory("baseline", [entry]);
    const final = inventory("final", [entry]);
    const edge = {
      id: "bad-cardinality",
      ...build(base, final),
      ...quality,
      rationale: "Changed edge rationale.",
    };
    expect(
      validateManifestData(manifestFor(base, final, [edge]), base, final, { strict: true }).join(
        "\n",
      ),
    ).toMatch(diagnostic);
  });

  it("validates inventory snapshot, success, totals, unique files, and case collisions", () => {
    const first = testEntry("Case/File.test.ts", "one");
    const second = testEntry("case/file.test.ts", "two");
    const value = inventory("wrong", [first, second]);
    value.report.success = "true";
    value.report.declaredTests = 3;
    value.report.declaredFiles = 3;
    const diagnostics = validateInventory(value, "fixture", "baseline").join("\n");
    expect(diagnostics).toContain("snapshot must be baseline or final");
    expect(diagnostics).toContain("must be baseline");
    expect(diagnostics).toContain("report success must be boolean");
    expect(diagnostics).toContain("declared test total 3 differs from 2");
    expect(diagnostics).toContain("declared file total 3 differs from 2 unique normalized files");
    expect(diagnostics).toContain("case-only path collision Case/File.test.ts / case/file.test.ts");
  });

  it.each([
    "Final full-suite pass.",
    "New distinct plan invariant, stronger replacement, or split attack/failure mode.",
    "Baseline pass; see final-key disposition/reconciliation below.",
    "Observable contract: command succeeds.",
    "The endpoint distinguishes missing identity, insufficient key scope, and authorized ownership.",
    "The stated malformed or out-of-policy input is rejected at its validation boundary.",
    "The named adversarial audit-tool branch protects exact identity, topology, quality validation, rendering, or independent reconciliation behavior.",
    "Admit this independently reported branch after the focused T29 replacement passed.",
    "Defect/mixed-Cause rows prove two-cycle no-resend.",
    "The read projection applies the requested ordering/filter/page semantics.",
    "The operation commits the intended resource transition and returns values.",
    "The production behavior described by `reporter title` is exercised with its exact asserted response.",
    "`file.test.ts` reporter branch `reporter title` executes `production.ts#symbol`; its assertions check the branch-specific output/state described by this record.",
    "This evidence is limited to the `reporter title` input/state and does not establish neighboring branches.",
    "Distinct inspected assertion branch: copied reporter title.",
    "The supplied `reporter title` case is refused at the production boundary.",
    "A case is refused at the production boundary, with its exact error/status and no side effect.",
    "The mapping is exercised directly and its exact normalized output or error category is asserted.",
    "The production path reports `reporter title` with a category.",
    "A generated claim with the asserted status/category/detail.",
    "Admitted after baseline because the `reporter title` branch was added.",
    "A branch protects this distinct failure/input/state; adjacent records exercise different values or boundaries.",
    "Creating `copied title suffix` produces the asserted request/response and durable rows without an extra resource.",
    "The scenario `copied title suffix` is prevented, as shown by the asserted unchanged state or zero call count.",
    "The `copied title suffix` scenario preserves the asserted state across the production operation.",
    "The CLI prints `copied title suffix` with the asserted stream, fields, ordering, and secret-exclusion behavior.",
    "The `copied title suffix` selection path is exercised and its exact path/request/output is asserted.",
    "The exact accepted input `copied title suffix` reaches the production branch and yields the asserted normalized value.",
    "Listing `copied title suffix` applies the asserted query/order/page shape and returns the exact projected fields.",
    "The production call yields `copied title suffix`, and assertions inspect the exact response/value rather than only mock interaction.",
    "The `copied title suffix` requirement fails closed or succeeds only with the asserted prerequisite.",
    "The fallback `copied title suffix` is selected only under the stated input and returns the asserted fixed result.",
    "Loading `copied title suffix` yields the asserted parsed configuration values and optional/default state.",
    "The `copied title suffix` condition is established by the exact asserted output and side effects.",
    "Reusing an idempotency key copied title suffix returns 409 and leaves the original mailing response unchanged.",
  ])("rejects known invalid audit boilerplate: %s", (evidence) => {
    const entry = testEntry("scripts/test-quality-audit/core.mjs", "boilerplate title");
    const base = inventory("baseline", [entry]);
    const final = inventory("final", [entry]);
    const edge = {
      id: "boilerplate",
      operation: "retain",
      from: [entry.id],
      to: [entry.id],
      ...quality,
      evidence,
    };
    expect(
      validateManifestData(manifestFor(base, final, [edge]), base, final, { strict: true }).join(
        "\n",
      ),
    ).toContain("generic blanket evidence is forbidden");
  });

  it("accepts only complete valid hosted passed claims or external-unvalidated in strict mode", () => {
    const entry = testEntry("scripts/test-quality-audit/core.mjs", "hosted title");
    const base = inventory("baseline", [entry]);
    const final = inventory("final", [entry]);
    const edge = {
      id: "hosted",
      operation: "retain",
      from: [entry.id],
      to: [entry.id],
      ...quality,
    };
    const external = manifestFor(base, final, [edge]);
    expect(validateManifestData(external, base, final, { strict: true })).toEqual([]);
    const passed = {
      ...external,
      hostedStatus: {
        status: "passed",
        url: "https://ci.example/run/42",
        runId: "42",
        headSha: "a".repeat(40),
        event: "push",
        conclusion: "success",
        date: "2026-07-10T00:00:00Z",
      },
    };
    expect(validateManifestData(passed, base, final, { strict: true })).toEqual([]);
    const incomplete = {
      ...external,
      hostedStatus: {
        status: "passed",
        url: "not-a-url",
        headSha: "bad",
        conclusion: "failure",
        date: "not-a-date",
      },
    };
    const diagnostics = validateManifestData(incomplete, base, final, { strict: true }).join("\n");
    expect(diagnostics).toContain("passed claim missing runId");
    expect(diagnostics).toContain("invalid url");
    expect(diagnostics).toContain("invalid headSha");
    expect(diagnostics).toContain("conclusion must be success");
    expect(diagnostics).toContain("invalid date");
    const unknown = { ...external, hostedStatus: { status: "pending" } };
    expect(validateManifestData(unknown, base, final, { strict: true }).join("\n")).toContain(
      "expected external-unvalidated",
    );
  });

  it("rejects discovered generator prose when hidden in a changed-edge rationale", () => {
    const baselineEntry = testEntry("scripts/test-quality-audit/core.mjs", "old identity");
    const finalEntry = testEntry("scripts/test-quality-audit/core.mjs", "new identity");
    const base = inventory("baseline", [baselineEntry]);
    const final = inventory("final", [finalEntry]);
    const edge = {
      id: "rewrite-with-template-rationale",
      operation: "rewrite",
      from: [baselineEntry.id],
      to: [finalEntry.id],
      ...quality,
      rationale: "Observable contract: generated rationale",
    };

    expect(
      validateManifestData(manifestFor(base, final, [edge]), base, final, { strict: true }).join(
        "\n",
      ),
    ).toContain("generic blanket evidence is forbidden");
  });

  it("rejects changed report bytes and stale deterministic Markdown", async () => {
    const directory = await mkdtemp(path.join(REPO_ROOT, "scripts/test-quality-audit/.tmp-"));
    temporary.push(directory);
    const raw = path.join(directory, "raw.json");
    await writeFile(raw, "changed");
    await expect(assertRawReportHash({ report: { sha256: "0".repeat(64) } }, raw)).rejects.toThrow(
      "raw report hash differs",
    );
    const entry = testEntry("scripts/test-quality-audit/core.mjs", "stale view");
    const base = inventory("baseline", [entry]);
    const baseText = `${JSON.stringify(base)}\n`;
    const basePath = path.join(directory, "base.json");
    await writeFile(basePath, baseText);
    const relativeDir = path.relative(REPO_ROOT, directory).split(path.sep).join("/");
    const manifest = manifestFor(base, undefined, [
      { id: "u", operation: "unresolved", from: [entry.id], to: [] },
    ]);
    manifest.inventories = {
      baseline: { path: `${relativeDir}/base.json`, sha256: sha256(baseText) },
      final: null,
    };
    manifest.generatedView.path = `${relativeDir}/audit.md`;
    const manifestPath = path.join(directory, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const auditPath = path.join(directory, "audit.md");
    await writeFile(auditPath, renderMarkdown(manifest, base));
    const independentArgs = [
      new URL("./independent-check.mjs", import.meta.url).pathname,
      "--mode",
      "baseline",
      "--manifest",
      manifestPath,
    ];
    const before = spawnSync(process.execPath, independentArgs, { encoding: "utf8" });
    const canonicalBefore = await validateAudit(manifestPath, { checkRender: false });
    await writeFile(auditPath, "manually modified noncanonical Markdown\n");
    const after = spawnSync(process.execPath, independentArgs, { encoding: "utf8" });
    const canonicalAfter = await validateAudit(manifestPath, { checkRender: false });
    expect(before.status).toBe(0);
    expect(after.status).toBe(0);
    expect(after.stdout).toBe(before.stdout);
    expect(canonicalAfter.errors).toEqual(canonicalBefore.errors);
    expect((await validateAudit(manifestPath)).errors).toContain(
      `generated view is stale: ${relativeDir}/audit.md`,
    );
    const renderCheck = spawnSync(
      process.execPath,
      [
        new URL("./cli.mjs", import.meta.url).pathname,
        "render",
        "--manifest",
        manifestPath,
        "--out",
        auditPath,
        "--check",
      ],
      { encoding: "utf8" },
    );
    expect(renderCheck.status).toBe(1);
    expect(renderCheck.stderr).toContain("generated view is stale");
  });

  it("exercises CLI import, validate, normalized compare, and non-writing render checks", async () => {
    const directory = await mkdtemp(path.join(REPO_ROOT, "scripts/test-quality-audit/.tmp-cli-"));
    temporary.push(directory);
    const cli = new URL("./cli.mjs", import.meta.url).pathname;
    const reportPath = path.join(directory, "report.json");
    const inventoryPath = path.join(directory, "inventory.json");
    const manifestPath = path.join(directory, "manifest.json");
    const auditPath = path.join(directory, "audit.md");
    const makeReport = (fullName = "CLI exact identity", success = true, timing = 1) => ({
      numTotalTests: 1,
      success,
      startTime: 1_700_000_000_000 + timing,
      testResults: [
        {
          name: new URL("./core.mjs", import.meta.url).pathname,
          startTime: timing,
          endTime: timing + 1,
          assertionResults: [{ fullName, duration: timing }],
        },
      ],
    });
    await writeFile(reportPath, JSON.stringify(makeReport()));
    const run = (...arguments_) =>
      spawnSync(process.execPath, [cli, ...arguments_], { encoding: "utf8" });
    const imported = run(
      "import",
      "--snapshot",
      "baseline",
      "--report",
      reportPath,
      "--inventory",
      inventoryPath,
    );
    expect(imported.status, imported.stderr).toBe(0);
    const importedInventory = JSON.parse(await readFile(inventoryPath, "utf8"));
    const relativeDir = path.relative(REPO_ROOT, directory).split(path.sep).join("/");
    const manifest = manifestFor(importedInventory, undefined, [
      {
        id: "unresolved-cli",
        operation: "unresolved",
        from: [importedInventory.tests[0].id],
        to: [],
      },
    ]);
    const inventoryBytes = await readFile(inventoryPath);
    manifest.inventories = {
      baseline: { path: `${relativeDir}/inventory.json`, sha256: sha256(inventoryBytes) },
      final: null,
    };
    manifest.generatedView.path = `${relativeDir}/audit.md`;
    await writeFile(manifestPath, JSON.stringify(manifest));
    expect(run("render", "--manifest", manifestPath, "--out", auditPath, "--write").status).toBe(0);
    const canonicalBytes = async () =>
      Promise.all([manifestPath, inventoryPath, auditPath].map((file) => readFile(file)));
    const before = await canonicalBytes();
    const validated = run("validate", "--manifest", manifestPath);
    expect(validated.status, validated.stderr).toBe(0);
    expect(validated.stdout).toContain("non-strict; baseline 1");
    const strict = run("validate", "--strict", "--manifest", manifestPath);
    expect(strict.status).toBe(1);
    expect(strict.stderr).toContain("classification unresolved");
    await writeFile(reportPath, JSON.stringify(makeReport("CLI exact identity", true, 999)));
    const compared = run(
      "compare-report",
      "--snapshot",
      "baseline",
      "--report",
      reportPath,
      "--inventory",
      inventoryPath,
    );
    expect(compared.status, compared.stderr).toBe(0);
    expect(compared.stdout).toContain("identity-deltas=0");
    await writeFile(reportPath, JSON.stringify(makeReport("CLI exact identity", false, 1000)));
    const successMismatch = run(
      "compare-report",
      "--snapshot",
      "baseline",
      "--report",
      reportPath,
      "--inventory",
      inventoryPath,
    );
    expect(successMismatch.status).toBe(1);
    expect(successMismatch.stderr).toContain("report success differs");
    const extraReport = makeReport("CLI exact identity", true, 1001);
    extraReport.numTotalTests = 2;
    extraReport.testResults[0].assertionResults.push({ fullName: "extra identity" });
    await writeFile(reportPath, JSON.stringify(extraReport));
    const totalMismatch = run(
      "compare-report",
      "--snapshot",
      "baseline",
      "--report",
      reportPath,
      "--inventory",
      inventoryPath,
    );
    expect(totalMismatch.status).toBe(1);
    expect(totalMismatch.stderr).toContain("test total differs");
    const checked = run("render", "--manifest", manifestPath, "--out", auditPath, "--check");
    expect(checked.status, checked.stderr).toBe(0);
    const after = await canonicalBytes();
    expect(after).toEqual(before);
    await writeFile(reportPath, JSON.stringify(makeReport("changed identity", true, 1000)));
    const mismatch = run(
      "compare-report",
      "--snapshot",
      "baseline",
      "--report",
      reportPath,
      "--inventory",
      inventoryPath,
    );
    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toContain("identity multiset differs");
    const usage = run("import", "--snapshot", "invalid");
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain("import requires --snapshot baseline|final");
  });

  it("independent built-ins-only checker agrees, then catches an occurrence/control mutation", async () => {
    const source = await readFile(new URL("./independent-check.mjs", import.meta.url), "utf8");
    expect(source).not.toMatch(/from ["']\.\/core\.mjs/);
    const directory = await mkdtemp(
      path.join(REPO_ROOT, "scripts/test-quality-audit/.tmp-independent-"),
    );
    temporary.push(directory);
    const relativeDir = path.relative(REPO_ROOT, directory).split(path.sep).join("/");
    const entries = [testEntry("x.ts", "control\nname", 0), testEntry("x.ts", "control\nname", 1)];
    const base = inventory("baseline", entries);
    let baseText = `${JSON.stringify(base)}\n`;
    await writeFile(path.join(directory, "base.json"), baseText);
    const dispositions = entries.map((entry) => ({
      id: `u-${entry.occurrence}`,
      operation: "unresolved",
      from: [entry.id],
      to: [],
    }));
    const manifest = manifestFor(base, undefined, dispositions);
    manifest.inventories = {
      baseline: { path: `${relativeDir}/base.json`, sha256: sha256(baseText) },
      final: null,
    };
    const manifestPath = path.join(directory, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const good = spawnSync(
      process.execPath,
      [
        new URL("./independent-check.mjs", import.meta.url).pathname,
        "--mode",
        "baseline",
        "--manifest",
        manifestPath,
      ],
      { encoding: "utf8" },
    );
    expect(good.status, good.stderr).toBe(0);
    expect(good.stdout).toContain("missing=0 extra=0");
    base.tests[1].occurrence = 2;
    base.tests[1].tuple[3] = 2;
    base.tests[1].fullName = "control\rname";
    base.tests[1].tuple[2] = "control\rname";
    baseText = `${JSON.stringify(base)}\n`;
    await writeFile(path.join(directory, "base.json"), baseText);
    manifest.inventories.baseline.sha256 = sha256(baseText);
    await writeFile(manifestPath, JSON.stringify(manifest));
    const bad = spawnSync(
      process.execPath,
      [
        new URL("./independent-check.mjs", import.meta.url).pathname,
        "--mode",
        "baseline",
        "--manifest",
        manifestPath,
      ],
      { encoding: "utf8" },
    );
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("computed ID differs");
    expect(bad.stderr).toContain("identity deltas");
  });
});
