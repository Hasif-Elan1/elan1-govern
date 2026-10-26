import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "apps/gate", "apps/web"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "text", "json-summary"],
      include: ["packages/*/src/**/*.ts", "apps/gate/src/**/*.ts", "apps/web/src/server/**/*.ts", "apps/web/src/lib/**/*.ts"],
      exclude: ["**/*.d.ts", "**/index.ts", "**/bin.ts", "**/main.ts", "packages/db/src/seed*.ts", "**/live/**"],
      thresholds: {
        lines: 80,
        statements: 80,
        "packages/core/src/**": { lines: 95, statements: 95, functions: 95, branches: 90 },
      },
    },
  },
});
