// Who can do what. Every route handler and every page that changes something names
// one of these permissions; the authz matrix test checks the whole table.

export const ROLES = ["owner", "admin", "approver", "viewer", "auditor"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = {
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
  "sso:manage": ["owner"],
  // AI inventory: everyone reads it; admins keep the register. Approvers can draft and
  // submit assessments; only owners and admins sign them off, never their own (see reviewProblem).
  "inventory:manage": ["owner", "admin"],
  "assessments:draft": ["owner", "admin", "approver"],
  "assessments:approve": ["owner", "admin"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role | null | undefined, permission: Permission): boolean {
  return !!role && (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  approver: "Approver",
  viewer: "Viewer",
  auditor: "Auditor",
};

export const ROLE_HINTS: Record<Role, string> = {
  owner: "Everything, including removing admins.",
  admin: "Sets up agents, rules, tools and members.",
  approver: "Approves or rejects actions that wait for a person, and drafts assessments.",
  viewer: "Sees activity. Changes nothing.",
  auditor: "Sees everything and downloads evidence. Changes nothing.",
};

/** Only an owner can grant or take away owner. */
export function canAssignRole(actor: Role, target: Role, current?: Role): boolean {
  if (!can(actor, "members:manage")) return false;
  if (actor === "owner") return true;
  return target !== "owner" && current !== "owner";
}
