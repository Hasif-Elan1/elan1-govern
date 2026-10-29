import { defineProject, mergeConfig } from "vitest/config";
import web from "./vitest.config";

// The console's tests (test/console*.test.ts) share the four demo organisations and their real chains, so they run
// one file at a time, after the web app's other tests.
export default mergeConfig(
  web,
  defineProject({
    test: {
      name: "web-console",
      include: ["test/console*.test.ts"],
      exclude: [],
      fileParallelism: false,
      sequence: { groupOrder: 2 },
    },
  }),
);
