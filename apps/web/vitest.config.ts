import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";
import { testEnv } from "../../test-env";

export default defineProject({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./test/server-only.ts", import.meta.url)),
    },
  },
  test: {
    name: "web",
    include: ["test/**/*.test.ts"],
    // the console's own tests write to the demo organisations' real chains: they run one file at a time in their
    // own project (vitest.console.config.ts)
    exclude: ["test/console*.test.ts"],
    env: testEnv(),
    globalSetup: ["test/build-console.ts"],
    // after the gate's and the packages' tests: the console tests seed the console's demo organisations and write
    // to their chains, which the gate's console-seed test seeds and counts on its own
    sequence: { groupOrder: 1 },
  },
});
