import { buildApp } from "./app";
import { expireDue } from "./approvals";
import { readGateEnv } from "./env";
import { checkpointAll } from "./evidence";

async function main() {
  let env;
  try {
    env = readGateEnv();
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  const { app, deps } = await buildApp(env);
  await app.listen({ port: env.GATE_PORT, host: "0.0.0.0" });

  const sweep = setInterval(() => void expireDue(deps).catch((e: Error) => app.log.warn({ err: e.message }, "expiry sweep failed")), 10_000);
  const hourly = setInterval(() => void checkpointAll(deps), 3_600_000);
  const stop = async () => {
    clearInterval(sweep);
    clearInterval(hourly);
    await app.close();
    await deps.db.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

void main();
