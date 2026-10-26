// Writes docs/openapi.json from the zod schemas:  pnpm --filter @gate/gate openapi
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { openApiText } from "./openapi";

const out = resolve(import.meta.dirname, "../../../docs/openapi.json");
writeFileSync(out, openApiText());
console.log(`Wrote ${out}`);
