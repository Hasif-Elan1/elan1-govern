import { dueWebhookDeliveries } from "@gate/db";
import { PgBoss } from "pg-boss";
import { expireDue } from "./approvals";
import { noQueue, type Deps, type JobQueue } from "./deps";
import { checkpointAll } from "./evidence";
import { DELIVER_QUEUE, deliverWebhook } from "./webhooks";

/**
 * Durable background jobs on pg-boss (tables in their own Postgres schema, JOBS_SCHEMA).
 * Cron schedules live in the database and pg-boss sends one job per tick however many Elan1 Govern
 * instances run; the "stately" policy keeps at most one queued and one running job per cron
 * queue, so a slow run is never doubled up.
 */
export const QUEUES = {
  expire: "approvals-expire",
  checkpoints: "checkpoints-hourly",
  sweep: "webhook-sweep",
  deliver: DELIVER_QUEUE,
} as const;

const CRON: { queue: string; cron: string }[] = [
  { queue: QUEUES.expire, cron: "* * * * *" },
  { queue: QUEUES.checkpoints, cron: "0 * * * *" },
  { queue: QUEUES.sweep, cron: "* * * * *" },
];

/** Re-sends deliveries that are due but whose job was lost (a crash, or written before jobs ran). */
export async function sweepWebhooks(deps: Deps): Promise<number> {
  let n = 0;
  for (const d of await dueWebhookDeliveries(new Date(), deps.db)) {
    if ((await deliverWebhook(deps, d.orgId, d.id).catch(() => "skipped")) !== "skipped") n++;
  }
  return n;
}

/** Runs one job and logs it without personal data: queue, duration, counts. */
export async function runLogged(deps: Deps, queue: string, fn: () => Promise<Record<string, unknown> | void>) {
  const started = Date.now();
  try {
    const result = (await fn()) ?? {};
    deps.log.info({ job: queue, ms: Date.now() - started, ...result }, "job done");
  } catch (e) {
    deps.log.warn({ job: queue, ms: Date.now() - started, err: (e as Error).message }, "job failed");
    throw e;
  }
}

export interface Jobs {
  boss: PgBoss;
  stop(): Promise<void>;
}

export function bossQueue(boss: PgBoss): JobQueue {
  return {
    async send(queue, data, opts = {}) {
      await boss.send(queue, data, { ...(opts.startAfter ? { startAfter: Math.ceil(opts.startAfter) } : {}), ...(opts.singletonKey ? { singletonKey: opts.singletonKey } : {}) });
    },
  };
}

export async function startJobs(deps: Deps, opts: { schedule?: boolean; pollingIntervalSeconds?: number } = {}): Promise<Jobs> {
  const boss = new PgBoss({ connectionString: deps.env.DATABASE_URL, schema: deps.env.JOBS_SCHEMA, application_name: "gate-jobs", max: 5 });
  boss.on("error", (e: Error) => deps.log.warn({ job: "pg-boss", err: e.message }, "job queue error"));
  await boss.start();

  for (const { queue } of CRON) await boss.createQueue(queue, { policy: "stately", retryLimit: 0, expireInSeconds: 600 });
  // Delivery retries are tracked on WebhookDelivery rows, not by pg-boss.
  await boss.createQueue(QUEUES.deliver, { policy: "standard", retryLimit: 0, expireInSeconds: 60 });
  if (opts.schedule !== false) for (const { queue, cron } of CRON) await boss.schedule(queue, cron);

  const polling = { pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 2 };
  await boss.work(QUEUES.expire, polling, () => runLogged(deps, QUEUES.expire, async () => ({ expired: await expireDue(deps) })));
  await boss.work(QUEUES.checkpoints, polling, () => runLogged(deps, QUEUES.checkpoints, async () => ({ signed: await checkpointAll(deps) })));
  await boss.work(QUEUES.sweep, polling, () => runLogged(deps, QUEUES.sweep, async () => ({ attempted: await sweepWebhooks(deps) })));
  await boss.work<{ orgId: string; deliveryId: string }>(QUEUES.deliver, { ...polling, batchSize: 5, localConcurrency: 4 }, async (jobs) => {
    for (const job of jobs) await deliverWebhook(deps, job.data.orgId, job.data.deliveryId);
  });

  deps.queue = bossQueue(boss);
  return {
    boss,
    async stop() {
      deps.queue = noQueue;
      await boss.stop({ graceful: true, timeout: 10_000 });
    },
  };
}
