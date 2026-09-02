import { defineConfig } from "vitest/config";

/**
 * Shared Vitest configuration for every package/app in the monorepo.
 *
 * Individual packages extend this via `mergeConfig` in their own
 * `vitest.config.ts`, and the root `vitest.config.ts` extends it to run the
 * whole workspace in a single pass (`pnpm test`).
 *
 * Test layout convention:
 *   - `<pkg>/src/**\/*.test.ts`   unit + property tests co-located with source
 *   - `tests/unit/**`             cross-cutting unit tests
 *   - `tests/integration/**`      real WSS / SQLite / MCP round-trips
 *   - `tests/simulation/**`       multi-agent simulation scenarios
 */
export const sharedTestConfig = defineConfig({
  test: {
    environment: "node",
    globals: false,
    // Packages without tests yet must not fail the aggregate run.
    passWithNoTests: true,
    testTimeout: 20_000,
    include: ["src/**/*.{test,spec}.ts", "tests/**/*.{test,spec}.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});

export default sharedTestConfig;
