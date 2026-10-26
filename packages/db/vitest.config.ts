import { defineProject } from "vitest/config";
import { testEnv } from "../../test-env";
export default defineProject({ test: { name: "db", include: ["test/**/*.test.ts"], env: testEnv() } });
