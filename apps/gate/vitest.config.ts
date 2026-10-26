import { defineProject } from "vitest/config";
import { testEnv } from "../../test-env";
export default defineProject({ test: { name: "gate", include: ["test/**/*.test.ts"], env: testEnv(), testTimeout: 30000, hookTimeout: 30000 } });
