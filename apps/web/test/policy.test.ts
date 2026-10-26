import { describe, expect, it } from "vitest";
import { can, canAssignRole, PERMISSIONS, ROLES, type Permission, type Role } from "../src/server/policy";

// The authorisation matrix: every role against every permission. A change to who can do
// what must change this table too.
const EXPECTED: Record<Permission, Role[]> = {
  view: ["owner", "admin", "approver", "viewer", "auditor"],
  "approvals:decide": ["owner", "admin", "approver"],
  "agents:manage": ["owner", "admin"],
  "rulebooks:publish": ["owner", "admin"],
  "connectors:manage": ["owner", "admin"],
  "evidence:export": ["owner", "admin", "auditor"],
  "evidence:checkpoint": ["owner", "admin", "auditor"],
  "settings:manage": ["owner", "admin"],
  "members:manage": ["owner", "admin"],
  "demo:run": ["owner", "admin"],
  "inventory:manage": ["owner", "admin"],
  "assessments:draft": ["owner", "admin", "approver"],
  "assessments:approve": ["owner", "admin"],
};

describe("authz matrix (policy)", () => {
  for (const perm of Object.keys(PERMISSIONS) as Permission[]) {
    for (const role of ROLES) {
      const allowed = EXPECTED[perm].includes(role);
      it(`${role} ${allowed ? "may" : "may not"} ${perm}`, () => expect(can(role, perm)).toBe(allowed));
    }
  }
  it("covers every permission", () => expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(PERMISSIONS).sort()));
  it("denies without a role", () => expect(can(null, "view")).toBe(false));
  it("only owners touch owners", () => {
    expect(canAssignRole("owner", "owner")).toBe(true);
    expect(canAssignRole("admin", "owner")).toBe(false);
    expect(canAssignRole("admin", "viewer", "owner")).toBe(false);
    expect(canAssignRole("admin", "approver", "viewer")).toBe(true);
    expect(canAssignRole("approver", "viewer", "viewer")).toBe(false);
  });
});
