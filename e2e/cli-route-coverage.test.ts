import { describe, expect, it } from "vitest";

import { parseCliCommand } from "../apps/cli/src/commands/options.ts";
import { withTestApp } from "../apps/service/src/testing/layers.ts";

import {
  collectProtectedAdminRoutes,
  diffProtectedRoutesToMatrix,
  formatCommandMismatchFailure,
  formatMissingRouteFailures,
  formatStaleMatrixFailures,
  normalizeRoute,
  routeKey,
  type CliRouteCoverageEntry,
  type RouteRef,
} from "./cli-route-coverage.ts";

/**
 * Complete CLI coverage matrix for protected administrative routes.
 * One entry per method+path; representative argv must parse to `kind`.
 */
const CLI_ROUTE_COVERAGE_MATRIX: readonly CliRouteCoverageEntry[] = [
  {
    method: "GET",
    path: "/api/api-keys",
    kind: "api-keys-list",
    argv: ["api-keys", "list"],
  },
  {
    method: "POST",
    path: "/api/api-keys",
    kind: "api-keys-create",
    argv: ["api-keys", "create", "--name", "coverage", "--permission", "contacts:read"],
  },
  {
    method: "DELETE",
    path: "/api/api-keys/:id",
    kind: "api-keys-revoke",
    argv: ["api-keys", "revoke", "key_1"],
  },
  {
    method: "POST",
    path: "/api/api-keys/:id/rotate",
    kind: "api-keys-rotate",
    argv: ["api-keys", "rotate", "key_1"],
  },
  {
    method: "GET",
    path: "/api/contacts",
    kind: "contacts-list",
    argv: ["contacts", "list"],
  },
  {
    method: "POST",
    path: "/api/contacts",
    kind: "contacts-create",
    argv: ["contacts", "create", "user@example.com"],
  },
  {
    method: "GET",
    path: "/api/contacts/:id",
    kind: "contacts-get",
    argv: ["contacts", "get", "contact_1"],
  },
  {
    method: "PATCH",
    path: "/api/contacts/:id",
    kind: "contacts-update",
    argv: ["contacts", "update", "contact_1", "renamed@example.com"],
  },
  {
    method: "DELETE",
    path: "/api/contacts/:id",
    kind: "contacts-delete",
    argv: ["contacts", "delete", "contact_1"],
  },
  {
    method: "GET",
    path: "/api/lists",
    kind: "lists-list",
    argv: ["lists", "list"],
  },
  {
    method: "POST",
    path: "/api/lists",
    kind: "lists-create",
    argv: ["lists", "create", "Customers"],
  },
  {
    method: "GET",
    path: "/api/lists/:id",
    kind: "lists-get",
    argv: ["lists", "get", "list_1"],
  },
  {
    method: "PATCH",
    path: "/api/lists/:id",
    kind: "lists-update",
    argv: ["lists", "update", "list_1", "Renamed"],
  },
  {
    method: "DELETE",
    path: "/api/lists/:id",
    kind: "lists-delete",
    argv: ["lists", "delete", "list_1"],
  },
  {
    method: "GET",
    path: "/api/lists/:id/contacts",
    kind: "lists-contacts-list",
    argv: ["lists", "contacts", "list", "list_1"],
  },
  {
    method: "POST",
    path: "/api/lists/:id/contacts",
    kind: "lists-contacts-import",
    argv: ["lists", "contacts", "import", "list_1", "--file", "contacts.json"],
  },
  {
    method: "DELETE",
    path: "/api/lists/:id/contacts/:contactId",
    kind: "lists-contacts-remove",
    argv: ["lists", "contacts", "remove", "list_1", "contact_1"],
  },
  {
    method: "GET",
    path: "/api/mailings",
    kind: "mailings-list",
    argv: ["mailings", "list"],
  },
  {
    method: "POST",
    path: "/api/mailings",
    kind: "mailings-create",
    argv: ["mailings", "create", "--file", "mailing.json"],
  },
  {
    method: "GET",
    path: "/api/mailings/:id",
    kind: "mailings-get",
    argv: ["mailings", "get", "mailing_1"],
  },
  {
    method: "GET",
    path: "/api/me",
    kind: "whoami",
    argv: ["whoami"],
  },
  {
    method: "GET",
    path: "/api/operations/deliveries",
    kind: "deliveries-list",
    argv: ["deliveries", "list"],
  },
  {
    method: "GET",
    path: "/api/operations/deliveries/:id",
    kind: "deliveries-get",
    argv: ["deliveries", "get", "delivery_1"],
  },
  {
    method: "GET",
    path: "/api/operations/summary",
    kind: "operations-summary",
    argv: ["operations", "summary"],
  },
  {
    method: "GET",
    path: "/api/operations/ses/events",
    kind: "ses-events-list",
    argv: ["ses", "events", "list"],
  },
  {
    method: "GET",
    path: "/api/operations/ses/events/:id",
    kind: "ses-events-get",
    argv: ["ses", "events", "get", "event_1"],
  },
  {
    method: "GET",
    path: "/api/operations/ses/readiness",
    kind: "ses-readiness",
    argv: ["ses", "readiness", "--no-aws"],
  },
  {
    method: "GET",
    path: "/api/operations/ses/setup-guide",
    kind: "ses-setup-guide",
    argv: ["ses", "setup-guide", "--no-aws"],
  },
  {
    method: "GET",
    path: "/api/operations/ses/simulator-runs",
    kind: "ses-simulator-runs-list",
    argv: ["ses", "simulator-runs", "list"],
  },
  {
    method: "GET",
    path: "/api/operations/ses/simulator-runs/:id",
    kind: "ses-simulator-runs-get",
    argv: ["ses", "simulator-runs", "get", "run_1"],
  },
  {
    method: "GET",
    path: "/api/operations/ses/summary",
    kind: "ses-summary",
    argv: ["ses", "summary"],
  },
  {
    method: "GET",
    path: "/api/suppressions",
    kind: "suppressions-list",
    argv: ["suppressions", "list"],
  },
  {
    method: "POST",
    path: "/api/suppressions",
    kind: "suppressions-create",
    argv: ["suppressions", "create", "blocked@example.com", "--scope", "all"],
  },
  {
    method: "DELETE",
    path: "/api/suppressions/:id",
    kind: "suppressions-delete",
    argv: ["suppressions", "delete", "suppression_1"],
  },
];

function assertMatrixCoversRoutes(
  protectedRoutes: readonly RouteRef[],
  matrix: readonly CliRouteCoverageEntry[],
): void {
  const diff = diffProtectedRoutesToMatrix(protectedRoutes, matrix);
  const failures = [
    ...formatMissingRouteFailures(diff.missingFromMatrix),
    ...formatStaleMatrixFailures(diff.staleMatrixEntries),
  ];
  expect(failures, failures.join("\n")).toEqual([]);
}

function assertMatrixArgvKinds(matrix: readonly CliRouteCoverageEntry[]): void {
  const failures: string[] = [];
  for (const entry of matrix) {
    try {
      const parsed = parseCliCommand(entry.argv);
      if (parsed.kind !== entry.kind) {
        failures.push(
          formatCommandMismatchFailure({
            entry,
            actualKind: parsed.kind,
          }),
        );
      }
    } catch (error) {
      failures.push(formatCommandMismatchFailure({ entry, error }));
    }
  }
  expect(failures, failures.join("\n")).toEqual([]);
}

describe("CLI protected route coverage", () => {
  it("covers every current protected admin route with a parseable CLI matrix entry", async () => {
    await withTestApp({}, async (app) => {
      const protectedRoutes = collectProtectedAdminRoutes(app.routes);

      // Verify against the live surface; do not hardcode the expected count alone.
      expect(protectedRoutes.length).toBeGreaterThan(0);
      expect(protectedRoutes.map(routeKey)).toEqual(
        [...protectedRoutes].sort((a, b) => routeKey(a).localeCompare(routeKey(b))).map(routeKey),
      );
      expect(new Set(protectedRoutes.map(routeKey)).size).toBe(protectedRoutes.length);

      // Current surface is 34 protected admin routes; assert live count + matrix size.
      expect(protectedRoutes).toHaveLength(34);
      expect(CLI_ROUTE_COVERAGE_MATRIX).toHaveLength(protectedRoutes.length);

      assertMatrixCoversRoutes(protectedRoutes, CLI_ROUTE_COVERAGE_MATRIX);
      assertMatrixArgvKinds(CLI_ROUTE_COVERAGE_MATRIX);

      // Exclusions must keep health/auth/activation/unsubscribe/webhook/device/middleware out.
      const excludedSamples = [
        normalizeRoute("GET", "/health"),
        normalizeRoute("GET", "/health/db"),
        normalizeRoute("GET", "/api/auth/*"),
        normalizeRoute("GET", "/cli/activate"),
        normalizeRoute("POST", "/cli/activate"),
        normalizeRoute("GET", "/unsubscribe/:token"),
        normalizeRoute("POST", "/api/webhooks/aws/sns/ses"),
        normalizeRoute("POST", "/api/device-authorizations"),
        normalizeRoute("POST", "/api/device-authorizations/token"),
        normalizeRoute("ALL", "/*"),
        normalizeRoute("ALL", "/api/operations/ses/*"),
      ];
      for (const sample of excludedSamples) {
        expect(protectedRoutes.map(routeKey)).not.toContain(routeKey(sample));
      }
      expect(collectProtectedAdminRoutes([{ method: "GET", path: "/api/admin/*" }])).toEqual([
        normalizeRoute("GET", "/api/admin/*"),
      ]);
    });
  });

  it("fails with an actionable missing-route message when a protected route is unwrapped", async () => {
    await withTestApp({}, async (app) => {
      const protectedRoutes = collectProtectedAdminRoutes(app.routes);
      const injected = normalizeRoute("POST", "/api/admin/unwrapped-route");
      const withInjected = [...protectedRoutes, injected];

      const diff = diffProtectedRoutesToMatrix(withInjected, CLI_ROUTE_COVERAGE_MATRIX);
      const messages = formatMissingRouteFailures(diff.missingFromMatrix);

      expect(diff.missingFromMatrix).toEqual([injected]);
      expect(messages).toEqual([
        "Missing CLI coverage for protected route: POST /api/admin/unwrapped-route. Add a matrix entry with command kind and representative argv.",
      ]);
      expect(() => assertMatrixCoversRoutes(withInjected, CLI_ROUTE_COVERAGE_MATRIX)).toThrow(
        /Missing CLI coverage for protected route: POST \/api\/admin\/unwrapped-route/,
      );
    });
  });

  it("fails with an actionable command mismatch when matrix argv/kind is corrupted", () => {
    const base = CLI_ROUTE_COVERAGE_MATRIX[0]!;
    const corruptedKind: CliRouteCoverageEntry = {
      ...base,
      kind: "not-a-real-kind",
    };
    const corruptedArgv: CliRouteCoverageEntry = {
      ...base,
      argv: ["api-keys", "not-a-subcommand"],
    };

    const kindFailures: string[] = [];
    try {
      const parsed = parseCliCommand(corruptedKind.argv);
      if (parsed.kind !== corruptedKind.kind) {
        kindFailures.push(
          formatCommandMismatchFailure({ entry: corruptedKind, actualKind: parsed.kind }),
        );
      }
    } catch (error) {
      kindFailures.push(formatCommandMismatchFailure({ entry: corruptedKind, error }));
    }

    const argvFailures: string[] = [];
    try {
      const parsed = parseCliCommand(corruptedArgv.argv);
      if (parsed.kind !== corruptedArgv.kind) {
        argvFailures.push(
          formatCommandMismatchFailure({ entry: corruptedArgv, actualKind: parsed.kind }),
        );
      }
    } catch (error) {
      argvFailures.push(formatCommandMismatchFailure({ entry: corruptedArgv, error }));
    }

    expect(kindFailures).toHaveLength(1);
    expect(kindFailures[0]).toMatch(
      /CLI coverage command mismatch for GET \/api\/api-keys → kind not-a-real-kind: parseCliCommand produced kind api-keys-list/,
    );

    expect(argvFailures).toHaveLength(1);
    expect(argvFailures[0]).toMatch(
      /CLI coverage command mismatch for GET \/api\/api-keys → kind api-keys-list: representative argv failed to parse/,
    );

    expect(() => assertMatrixArgvKinds([corruptedKind])).toThrow(/command mismatch/);
    expect(() => assertMatrixArgvKinds([corruptedArgv])).toThrow(/command mismatch/);
  });

  it("fails when the matrix contains a stale route that is no longer protected", async () => {
    await withTestApp({}, async (app) => {
      const protectedRoutes = collectProtectedAdminRoutes(app.routes);
      const staleEntry: CliRouteCoverageEntry = {
        method: "GET",
        path: "/api/stale-admin-route",
        kind: "whoami",
        argv: ["whoami"],
      };
      const matrixWithStale = [...CLI_ROUTE_COVERAGE_MATRIX, staleEntry];

      const diff = diffProtectedRoutesToMatrix(protectedRoutes, matrixWithStale);
      const messages = formatStaleMatrixFailures(diff.staleMatrixEntries);

      expect(diff.staleMatrixEntries).toEqual([normalizeRoute("GET", "/api/stale-admin-route")]);
      expect(messages).toEqual([
        "Stale CLI coverage matrix entry (no matching protected route): GET /api/stale-admin-route. Remove or update the matrix entry.",
      ]);
      expect(() => assertMatrixCoversRoutes(protectedRoutes, matrixWithStale)).toThrow(
        /Stale CLI coverage matrix entry \(no matching protected route\): GET \/api\/stale-admin-route/,
      );
    });
  });
});
