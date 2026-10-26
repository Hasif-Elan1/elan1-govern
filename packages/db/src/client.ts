import { PrismaClient } from "@prisma/client";

const g = globalThis as unknown as { __gatePrisma?: PrismaClient };

/**
 * The raw client. Outside this package it may only touch global tables
 * (User, Session) — tenant tables go through forOrg(). A test enforces this.
 */
export const prisma: PrismaClient = g.__gatePrisma ?? new PrismaClient({ log: ["error"] });
if (process.env.NODE_ENV !== "production") g.__gatePrisma = prisma;

export type Db = PrismaClient;
