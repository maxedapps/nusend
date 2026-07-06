import path from "node:path";
import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(projectRoot, "migrations"));

  return {
    plugins: [
      cloudflareTest({
        miniflare: {
          // Test-only binding so the setup file can apply D1 migrations.
          bindings: { TEST_MIGRATIONS: migrations },
        },
        wrangler: { configPath: "./wrangler.jsonc" },
      }),
    ],
    test: {
      include: ["src/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
