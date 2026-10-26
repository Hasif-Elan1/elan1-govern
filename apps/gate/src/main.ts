import { buildApp } from "./app";
import { readGateEnv } from "./env";
import { startJobs } from "./jobs";

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

  // Approval expiry (every minute), hourly checkpoints and webhook delivery run on pg-boss,
  // so they survive restarts and run once across several Elan1 Govern instances.
  const jobs = await startJobs(deps);
  const stop = async () => {
    await jobs.stop().catch((e: Error) => app.log.warn({ err: e.message }, "job queue did not stop cleanly"));
    await app.close();
    await Promise.allSettled([...deps.background]);
    await deps.db.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

void main();
