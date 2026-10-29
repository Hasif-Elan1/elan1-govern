import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The console tests run the built domain (`@gate/console/server`): build it first if a console source changed. */
export default function setup() {
  execFileSync(process.execPath, [fileURLToPath(new URL("../../console/scripts/build-server.mjs", import.meta.url)), "--if-stale"], { stdio: "inherit" });
}
