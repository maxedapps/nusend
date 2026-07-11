import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@nusend/api-contract/permissions",
        replacement: fileURLToPath(
          new URL("./packages/api-contract/src/permissions.ts", import.meta.url),
        ),
      },
      {
        find: /^@nusend\/api-contract$/,
        replacement: fileURLToPath(
          new URL("./packages/api-contract/src/index.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    clearMocks: true,
    environment: "node",
    exclude: ["**/dist/**", "**/node_modules/**", ".progress/**"],
    globals: false,
    restoreMocks: true,
  },
});
