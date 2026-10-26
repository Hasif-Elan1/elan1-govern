// Prints fresh secrets for a production .env. Nothing is written to disk.
import { randomBytes } from "node:crypto";

for (const name of ["GATE_MASTER_KEY", "INTERNAL_API_SECRET", "APPROVAL_LINK_SECRET", "WEB_ENC_KEY"]) {
  console.log(`${name}=${randomBytes(32).toString("hex")}`);
}
console.log(`DEMO_AGENT_KEY=gk_${randomBytes(32).toString("base64url")}`);
