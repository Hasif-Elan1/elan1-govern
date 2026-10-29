import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";
import { testEnv } from "../../test-env";

// The console driving the real guard, end to end (test/*.guard.ts): the console's demo organisations, their
// documents and the gate's tables for them. Other tests reset those documents (test/console.test.ts), so these
// run after every other project has finished (groupOrder 1), one file at a time.
export default defineProject({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./test/server-only.ts", import.meta.url)),
    },
  },
  test: {
    name: "web-guardsync",
    include: ["test/**/*.guard.ts"],
    env: { ...testEnv(), CONSOLE_GUARD_SYNC: "on" },
    globalSetup: ["test/build-console.ts"],
    sequence: { groupOrder: 1 },
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
