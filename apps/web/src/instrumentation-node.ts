import { env } from "./server/env";

try {
  env();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
