import type { PrismaClient } from "@prisma/client";
import { prisma as defaultClient } from "./client";

/*
 * Elan1 platform staff: the people who work elan1's side of billing (the billing desk). A flag on the account,
 * never on a membership, so no organisation's owner can grant it: it is set only from the command line on the
 * server (`pnpm govern staff add <email>`), and every account starts without it.
 */

export interface StaffAccount {
  id: string;
  email: string;
  name: string;
  isPlatformStaff: boolean;
}

const SELECT = { id: true, email: true, name: true, isPlatformStaff: true } as const;

/** Make an account platform staff (or not). Returns the account, or null when no account has that email. */
export async function setPlatformStaff(email: string, on: boolean, client: PrismaClient = defaultClient): Promise<StaffAccount | null> {
  const address = email.trim().toLowerCase();
  const user = await client.user.findUnique({ where: { email: address }, select: { id: true } });
  if (!user) return null;
  return client.user.update({ where: { id: user.id }, data: { isPlatformStaff: on }, select: SELECT });
}

/** Every platform staff account, by email. */
export function platformStaff(client: PrismaClient = defaultClient): Promise<StaffAccount[]> {
  return client.user.findMany({ where: { isPlatformStaff: true }, select: SELECT, orderBy: { email: "asc" } });
}

/** Whether this account is platform staff. */
export async function isPlatformStaff(userId: string, client: PrismaClient = defaultClient): Promise<boolean> {
  return !!(await client.user.findUnique({ where: { id: userId }, select: { isPlatformStaff: true } }))?.isPlatformStaff;
}
