import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

/** The console's own unit tests (its live-build plumbing: the HTTP client, the operation transform, the engine). */
export default defineProject({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  esbuild: { jsx: "automatic" },
  test: { name: "console", include: ["test/**/*.test.ts"], environment: "node" },
});
