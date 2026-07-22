/** Pure helpers for CLI ↔ protected-route coverage comparisons. */

export type RouteRef = {
  readonly method: string;
  readonly path: string;
};

export type CliRouteCoverageEntry = RouteRef & {
  readonly kind: string;
  readonly argv: readonly string[];
};

export type RouteCoverageDiff = {
  readonly missingFromMatrix: readonly RouteRef[];
  readonly staleMatrixEntries: readonly RouteRef[];
};

export function normalizeRoute(method: string, path: string): RouteRef {
  return {
    method: method.toUpperCase(),
    path,
  };
}

export function routeKey(route: RouteRef): string {
  return `${route.method} ${route.path}`;
}

/**
 * Explicit out-of-scope surface for the admin CLI coverage guard:
 * health, Better Auth wildcard, browser activation, unsubscribe,
 * provider webhooks, device start/token (login-internal), and
 * Hono middleware/mount registrations (`ALL`).
 */
export function isExcludedFromCliCoverage(route: RouteRef): boolean {
  const { method, path } = route;

  if (method === "ALL") return true;

  if (path === "/health" || path === "/health/db") return true;
  if (path === "/api/auth" || path.startsWith("/api/auth/")) return true;
  if (path === "/cli" || path.startsWith("/cli/")) return true;
  if (path === "/unsubscribe" || path.startsWith("/unsubscribe/")) return true;
  if (path === "/api/webhooks" || path.startsWith("/api/webhooks/")) return true;
  if (path === "/api/device-authorizations" || path.startsWith("/api/device-authorizations/")) {
    return true;
  }

  return false;
}

export function collectProtectedAdminRoutes(
  routes: readonly { readonly method: string; readonly path: string }[],
): RouteRef[] {
  const seen = new Set<string>();
  const protectedRoutes: RouteRef[] = [];

  for (const raw of routes) {
    const route = normalizeRoute(raw.method, raw.path);
    if (isExcludedFromCliCoverage(route)) continue;
    const key = routeKey(route);
    if (seen.has(key)) continue;
    seen.add(key);
    protectedRoutes.push(route);
  }

  protectedRoutes.sort((left, right) => routeKey(left).localeCompare(routeKey(right)));
  return protectedRoutes;
}

export function diffProtectedRoutesToMatrix(
  protectedRoutes: readonly RouteRef[],
  matrix: readonly CliRouteCoverageEntry[],
): RouteCoverageDiff {
  const protectedKeys = new Set(protectedRoutes.map(routeKey));
  const matrixKeys = new Set(matrix.map((entry) => routeKey(entry)));

  const missingFromMatrix = protectedRoutes.filter((route) => !matrixKeys.has(routeKey(route)));
  const staleMatrixEntries = matrix
    .filter((entry) => !protectedKeys.has(routeKey(entry)))
    .map((entry) => normalizeRoute(entry.method, entry.path));

  return { missingFromMatrix, staleMatrixEntries };
}

export function formatMissingRouteFailures(missing: readonly RouteRef[]): string[] {
  return missing.map(
    (route) =>
      `Missing CLI coverage for protected route: ${routeKey(route)}. Add a matrix entry with command kind and representative argv.`,
  );
}

export function formatStaleMatrixFailures(stale: readonly RouteRef[]): string[] {
  return stale.map(
    (route) =>
      `Stale CLI coverage matrix entry (no matching protected route): ${routeKey(route)}. Remove or update the matrix entry.`,
  );
}

export function formatCommandMismatchFailure(input: {
  readonly entry: CliRouteCoverageEntry;
  readonly actualKind?: string;
  readonly error?: unknown;
}): string {
  const target = `${routeKey(input.entry)} → kind ${input.entry.kind}`;
  if (input.error !== undefined) {
    const message = input.error instanceof Error ? input.error.message : String(input.error);
    return `CLI coverage command mismatch for ${target}: representative argv failed to parse (${message}).`;
  }
  return `CLI coverage command mismatch for ${target}: parseCliCommand produced kind ${input.actualKind ?? "<none>"}.`;
}
