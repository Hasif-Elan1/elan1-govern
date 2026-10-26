import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma as defaultClient } from "./client";

/** Every model that belongs to an organisation. */
export const TENANT_MODELS = [
  "Membership",
  "Invite",
  "Agent",
  "ApiKey",
  "Rulebook",
  "Connector",
  "Approval",
  "ApprovalLink",
  "Receipt",
  "Checkpoint",
  "Control",
  "AiSystem",
  "Assessment",
] as const;

const WHERE_OPS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
  "upsert",
]);

type Args = Record<string, unknown> & { where?: Record<string, unknown>; data?: unknown; create?: unknown };

function scopeArgs(model: string, operation: string, args: Args, orgId: string): Args {
  const key = model === "Org" ? "id" : "orgId";
  const next: Args = { ...args };
  if (WHERE_OPS.has(operation)) {
    // AND the scope on, so a caller's own filter (even on orgId or id) can only narrow it.
    const where = args.where ?? {};
    const and = where.AND === undefined ? [] : Array.isArray(where.AND) ? where.AND : [where.AND];
    next.where = { ...where, AND: [...and, { [key]: orgId }] };
  }
  if (model === "Org") {
    if (operation.startsWith("create")) throw new Error("orgs are created through the gate service");
    return next;
  }
  if (operation === "create") next.data = { ...(args.data as object), orgId };
  if (operation === "createMany" || operation === "createManyAndReturn") {
    const rows = Array.isArray(args.data) ? args.data : [args.data];
    next.data = rows.map((r) => ({ ...(r as object), orgId }));
  }
  if (operation === "upsert") next.create = { ...(args.create as object), orgId };
  if ((operation === "update" || operation === "updateMany" || operation === "upsert") && args.data) {
    const { orgId: _drop, ...rest } = args.data as Record<string, unknown>;
    next.data = rest;
  }
  return next;
}

/**
 * The one way to read or write tenant data. Every query on a tenant model is
 * forced to the given orgId: filters get `orgId` added, creates get it set,
 * and updates cannot move a row to another org.
 */
export function forOrg(orgId: string, client: PrismaClient = defaultClient) {
  if (!orgId || typeof orgId !== "string") throw new Error("forOrg needs an orgId");
  const scoped = new Set<string>([...TENANT_MODELS, "Org"]);
  return client.$extends({
    name: `tenant:${orgId}`,
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!scoped.has(model)) {
            throw new Error(`${model} is not a tenant model; use the global client`);
          }
          return query(scopeArgs(model, operation, args as Args, orgId) as never);
        },
      },
    },
  });
}

export type OrgDb = ReturnType<typeof forOrg>;
export { Prisma };
