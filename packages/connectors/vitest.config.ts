import { defineProject } from "vitest/config";
export default defineProject({ test: { name: "connectors", include: ["test/**/*.test.ts"] } });
