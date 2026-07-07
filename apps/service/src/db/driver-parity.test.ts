// Permanent smoke guarding node:sqlite (test layer) / bun:sqlite (production
// layer) drift: the same queue cycle must produce byte-identical snapshots.
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { cleanupBunScenarios, runBunScenario } from "../testing/bun-scenario.ts";
import { runDriverParityCycle } from "../testing/driver-parity.ts";
import { DatabaseNodeLive } from "../testing/layers.ts";

const serviceRoot = fileURLToPath(new URL("../../", import.meta.url));

afterEach(() => cleanupBunScenarios());

describe("driver parity", () => {
  it("produces identical queue-cycle snapshots on node:sqlite and bun:sqlite", async () => {
    const nodeSnapshot = await runDriverParityCycle(
      DatabaseNodeLive(":memory:", { migrate: false }),
    );

    const result = runBunScenario(
      `
        import { DatabaseBunLive } from ${JSON.stringify(`${serviceRoot}src/services/database-bun.ts`)};
        import { runDriverParityCycle } from ${JSON.stringify(`${serviceRoot}src/testing/driver-parity.ts`)};

        console.log(JSON.stringify(await runDriverParityCycle(DatabaseBunLive(":memory:"))));
      `,
      serviceRoot,
    );

    expect(result.status, result.stderr).toBe(0);
    const bunSnapshot: unknown = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "");

    expect(bunSnapshot).toEqual(JSON.parse(JSON.stringify(nodeSnapshot)));
  });
});
