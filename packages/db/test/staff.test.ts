import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { isPlatformStaff, platformStaff, prisma, setPlatformStaff } from "../src";

afterAll(() => prisma.$disconnect());

describe("Elan1 platform staff", () => {
  it("is off for every new account, and set or taken away by email only", async () => {
    const email = `desk-${randomBytes(4).toString("hex")}@elan1.test`;
    const u = await prisma.user.create({ data: { email, name: "Desk", passwordHash: "x" } });
    expect(u.isPlatformStaff).toBe(false);
    expect(await isPlatformStaff(u.id)).toBe(false);

    expect(await setPlatformStaff(`  ${email.toUpperCase()} `, true)).toMatchObject({ id: u.id, isPlatformStaff: true });
    expect(await isPlatformStaff(u.id)).toBe(true);
    expect((await platformStaff()).map((s) => s.email)).toContain(email);

    expect(await setPlatformStaff(email, false)).toMatchObject({ isPlatformStaff: false });
    expect((await platformStaff()).map((s) => s.email)).not.toContain(email);
    expect(await setPlatformStaff(`nobody-${email}`, true)).toBeNull();
    expect(await isPlatformStaff("no-such-user")).toBe(false);
  });
});
