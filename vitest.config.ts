import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "apps/gate", "apps/web", "apps/console"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "text", "json-summary"],
      include: ["packages/*/src/**/*.ts", "apps/gate/src/**/*.ts", "apps/web/src/server/**/*.ts", "apps/web/src/lib/**/*.ts"],
      exclude: ["**/*.d.ts", "**/index.ts", "**/main.ts", "apps/gate/src/seed.ts", "apps/gate/src/demo/cli.ts", "apps/gate/src/openapi-cli.ts"],
      thresholds: {
        lines: 80,
        statements: 80,
        "packages/core/src/**": { lines: 95, statements: 95, functions: 95, branches: 90 },
      },
    },
  },
});
