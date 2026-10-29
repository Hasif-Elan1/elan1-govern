import { defineProject } from "vitest/config";
import web from "./vitest.config";

// The console's tests (test/console*.test.ts) share the four demo organisations and their real chains, so they run
// one file at a time, after the web app's other tests. Built from the web project's settings, not merged with them:
// mergeConfig would add these include and exclude lists to the web project's, which exclude these very files.
export default defineProject({
  resolve: web.resolve,
  test: {
    ...web.test,
    name: "web-console",
    include: ["test/console*.test.ts"],
    exclude: [],
    fileParallelism: false,
    sequence: { groupOrder: 2 },
  },
});
