// The approved console's demo organisations and people, as `pnpm db:seed` writes them into the real
// User, Org and Membership tables. Ids, names, emails, roles and levels are the console's own
// (apps/console/src/mock/users.ts and src/features/auth/registry.ts), so its screens resolve the same
// people. No passwords or TOTP secrets live here: every account shares DEMO_CONSOLE_PASSWORD from .env,
// and two-step secrets are generated per install by the seed.

export type ConsoleLevel = "l1" | "l2" | "l3" | "sovereign";
export type ConsoleRole = "owner" | "admin" | "approver" | "viewer" | "auditor";

export interface ConsoleOrg {
  id: string;
  name: string;
  slug: string;
  /** Industry pack id (packages/core/src/frameworks/packs.ts). */
  industry: "finance" | "general" | "healthcare";
  regions: ("india" | "eu" | "uk")[];
  currency: string;
  timezone: string;
  level: ConsoleLevel;
  domain: string;
}

export interface ConsolePerson {
  id: string;
  name: string;
  email: string;
  title: string;
  /** Two-step sign-in. The seed gives these accounts a TOTP secret. */
  mfa: boolean;
  memberships: { orgId: string; role: ConsoleRole; status: "active" | "suspended" }[];
}

export const CONSOLE_ORGS: ConsoleOrg[] = [
  { id: "org_demo", name: "Demo Traders Pvt Ltd", slug: "demo-traders", industry: "finance", regions: ["india", "eu"], currency: "INR", timezone: "Asia/Kolkata", level: "l1", domain: "demotraders.in" },
  { id: "org_northbank", name: "Northbank Industrial Ltd", slug: "northbank", industry: "general", regions: ["india", "uk"], currency: "INR", timezone: "Asia/Kolkata", level: "l2", domain: "northbank.co.in" },
  { id: "org_kaveri", name: "Kaveri Health Network", slug: "kaveri-health", industry: "healthcare", regions: ["india"], currency: "INR", timezone: "Asia/Kolkata", level: "l3", domain: "kaverihealth.in" },
  { id: "org_deccan", name: "Deccan Cooperative Bank Ltd", slug: "deccan-bank", industry: "finance", regions: ["india"], currency: "INR", timezone: "Asia/Kolkata", level: "sovereign", domain: "deccanbank.coop.in" },
];

const p = (id: string, name: string, email: string, role: ConsoleRole, title: string, orgId: string, mfa = true): ConsolePerson => ({
  id,
  name,
  email,
  title,
  mfa,
  memberships: [{ orgId, role, status: "active" }],
});

export const CONSOLE_PEOPLE: ConsolePerson[] = [
  // Demo Traders — L1
  p("u_ananya", "Ananya Rao", "ananya.rao@demotraders.in", "owner", "Head of Operations", "org_demo"),
  p("u_rahul", "Rahul Menon", "rahul.menon@demotraders.in", "admin", "Platform Lead", "org_demo"),
  p("u_venkat", "Venkat Iyer", "venkat.iyer@demotraders.in", "approver", "Finance Controller", "org_demo"),
  p("u_meera", "Meera Shah", "meera.shah@demotraders.in", "viewer", "Risk Analyst", "org_demo", false),
  {
    id: "u_kavita",
    name: "Kavita Desai",
    email: "kavita.desai@desaico.in",
    title: "Partner, Desai & Co. Chartered Accountants",
    mfa: true,
    memberships: ["org_demo", "org_northbank", "org_kaveri", "org_deccan"].map((orgId) => ({ orgId, role: "auditor" as const, status: "active" as const })),
  },
  p("u_arjun", "Arjun Nair", "arjun.nair@demotraders.in", "approver", "Procurement Manager", "org_demo"),
  p("u_fatima", "Fatima Sheikh", "fatima.sheikh@demotraders.in", "admin", "Data Protection Officer", "org_demo"),
  p("u_sanjay", "Sanjay Gupta", "sanjay.gupta@demotraders.in", "approver", "Engineering Manager", "org_demo"),
  p("u_priya", "Priya Krishnan", "priya.krishnan@demotraders.in", "viewer", "Internal Audit", "org_demo", false),
  p("u_tom", "Tom Whitfield", "tom.whitfield@demotraders.eu", "approver", "EU Finance Lead", "org_demo"),
  // Northbank Industrial — L2
  p("u_rohan", "Rohan Kapoor", "rohan.kapoor@northbank.co.in", "owner", "Chief Financial Officer", "org_northbank"),
  p("u_nb_neha", "Neha Bhatia", "neha.bhatia@northbank.co.in", "admin", "Head of Digital Operations", "org_northbank"),
  p("u_nb_gaurav", "Gaurav Sethi", "gaurav.sethi@northbank.co.in", "approver", "Financial Controller", "org_northbank"),
  p("u_nb_imran", "Imran Qureshi", "imran.qureshi@northbank.co.in", "approver", "Purchase Manager", "org_northbank"),
  p("u_nb_shalini", "Shalini Rao", "shalini.rao@northbank.co.in", "admin", "Data Protection Officer", "org_northbank"),
  p("u_nb_karthik", "Karthik Subramanian", "karthik.s@northbank.co.in", "approver", "Plant Systems Manager", "org_northbank"),
  p("u_nb_pooja", "Pooja Malhotra", "pooja.malhotra@northbank.co.in", "viewer", "Risk Analyst", "org_northbank", false),
  p("u_nb_deepak", "Deepak Jain", "deepak.jain@northbank.co.in", "viewer", "Internal Audit", "org_northbank", false),
  p("u_nb_james", "James Holloway", "james.holloway@northbank.co.uk", "approver", "UK Finance Lead", "org_northbank"),
  // Kaveri Health Network — L3
  p("u_lakshmi", "Dr Lakshmi Pillai", "lakshmi.pillai@kaverihealth.in", "owner", "Chief Operating Officer", "org_kaveri"),
  p("u_kh_arvind", "Arvind Swamy", "arvind.swamy@kaverihealth.in", "admin", "Head of Clinical Systems", "org_kaveri"),
  p("u_kh_revathi", "Revathi Natarajan", "revathi.n@kaverihealth.in", "approver", "Revenue Cycle Controller", "org_kaveri"),
  p("u_kh_rafi", "Mohammed Rafi", "mohammed.rafi@kaverihealth.in", "approver", "Procurement Head", "org_kaveri"),
  p("u_kh_sneha", "Dr Sneha Varghese", "sneha.varghese@kaverihealth.in", "admin", "Data Protection Officer", "org_kaveri"),
  p("u_kh_vivek", "Vivek Raman", "vivek.raman@kaverihealth.in", "approver", "IT Infrastructure Manager", "org_kaveri"),
  p("u_kh_nandini", "Nandini Hegde", "nandini.hegde@kaverihealth.in", "viewer", "Quality and Risk", "org_kaveri", false),
  p("u_kh_lata", "Lata Reddy", "lata.reddy@kaverihealth.in", "viewer", "Internal Audit", "org_kaveri", false),
  p("u_kh_joseph", "Joseph Mathew", "joseph.mathew@kaverihealth.in", "approver", "Insurance Desk Lead", "org_kaveri"),
  // Deccan Cooperative Bank — Sovereign
  p("u_suresh", "Suresh Nambiar", "suresh.nambiar@deccanbank.coop.in", "owner", "Chief Technology Officer", "org_deccan"),
  p("u_anjali", "Anjali Kulkarni", "anjali.kulkarni@deccanbank.coop.in", "admin", "Head of IT Risk", "org_deccan"),
  p("u_dc_prakash", "Prakash Deshpande", "prakash.deshpande@deccanbank.coop.in", "approver", "Chief Accountant", "org_deccan"),
  p("u_dc_farhan", "Farhan Siddiqui", "farhan.siddiqui@deccanbank.coop.in", "approver", "Vendor Management Head", "org_deccan"),
  p("u_dc_meenakshi", "Meenakshi Sundaram", "meenakshi.s@deccanbank.coop.in", "admin", "Data Protection Officer", "org_deccan"),
  p("u_dc_rajesh", "Rajesh Patil", "rajesh.patil@deccanbank.coop.in", "approver", "Data Centre Operations Manager", "org_deccan"),
  p("u_dc_sunita", "Sunita Joshi", "sunita.joshi@deccanbank.coop.in", "viewer", "Compliance Officer", "org_deccan", false),
  p("u_dc_geeta", "Geeta Bhat", "geeta.bhat@deccanbank.coop.in", "viewer", "Concurrent Auditor", "org_deccan", false),
  p("u_dc_ashwin", "Ashwin Kamath", "ashwin.kamath@deccanbank.coop.in", "approver", "Treasury Manager", "org_deccan"),
];

/** Members the console starts suspended (src/features/auth/signInPolicy.ts SEEDED_SUSPENSIONS). */
export const CONSOLE_SUSPENSIONS = [
  { orgId: "org_northbank", userId: "u_nb_deepak", by: "u_nb_neha", reason: "Moved to a group audit role; access paused while the access review is open" },
];
for (const s of CONSOLE_SUSPENSIONS) {
  const m = CONSOLE_PEOPLE.find((x) => x.id === s.userId)?.memberships.find((x) => x.orgId === s.orgId);
  if (m) m.status = "suspended";
}

/** Invitations the console lists as pending (src/mock/users.ts INVITED). */
export const CONSOLE_INVITES = [{ orgId: "org_demo", email: "deepa.joshi@demotraders.in", role: "approver" as ConsoleRole, invitedBy: "u_ananya" }];

/**
 * The sign-in page's "Demo accounts" panel, in the console's order: DEMO_ACCOUNTS (src/mock/users.ts),
 * then the extra accounts for dual control (EXTRA in src/features/auth/registry.ts). Grouped by level there.
 */
export const CONSOLE_DEMO_ACCOUNTS: { userId: string; orgId: string; journey: string }[] = [
  { userId: "u_ananya", orgId: "org_demo", journey: "Run the operation: Today, agents, emergency stop, the meter, then the upgrade to L2." },
  { userId: "u_rahul", orgId: "org_demo", journey: "Build: add an agent, write and publish a rulebook, connect an MCP server." },
  { userId: "u_venkat", orgId: "org_demo", journey: "Decide: work the approvals inbox, approve a held payment." },
  { userId: "u_meera", orgId: "org_demo", journey: "Watch: read activity, coverage and alerts. Changes nothing." },
  { userId: "u_kavita", orgId: "org_demo", journey: "Audit four clients, one per level: sample receipts, export a bundle, verify it with six result codes." },
  { userId: "u_rohan", orgId: "org_northbank", journey: "Attested: timestamps from two authorities, sealed records, the L1→L2 boundary, ledger1 and an 8-member evidence bundle." },
  { userId: "u_lakshmi", orgId: "org_kaveri", journey: "Proven: counterparties, selective disclosure, earned autonomy and customer-held keys." },
  { userId: "u_suresh", orgId: "org_deccan", journey: "Sovereign: your cluster, your HSM, local timestamp authorities, no egress, air-gapped signed updates." },
  { userId: "u_anjali", orgId: "org_deccan", journey: "Run the platform: verify, stage and apply an update bundle; run a key ceremony; read the egress log." },
  { userId: "u_fatima", orgId: "org_demo", journey: "Second admin and Data Protection Officer: the second person on a rulebook review and on erasure approvals." },
  { userId: "u_tom", orgId: "org_demo", journey: "Second Finance approver: the backup that escalated approvals re-route to." },
  { userId: "u_arjun", orgId: "org_demo", journey: "Procurement approver: try a held call outside your group and see it refused." },
  { userId: "u_nb_neha", orgId: "org_northbank", journey: "Draft a rulebook change and request a review — at L2 it cannot be published without a second person." },
  { userId: "u_nb_gaurav", orgId: "org_northbank", journey: "Decide held payments; your decisions are sealed and timestamped by two authorities." },
  { userId: "u_nb_imran", orgId: "org_northbank", journey: "Procurement approver, with Gaurav Sethi. Purchases nobody decides within 4 hours escalate to Finance, Procurement’s backup group; try a held Finance payment and see it refused." },
  { userId: "u_nb_shalini", orgId: "org_northbank", journey: "Data Protection Officer: open a DPDP erasure and approve one opened by someone else." },
  { userId: "u_nb_pooja", orgId: "org_northbank", journey: "Watch at L2: read signed, timestamped receipts, coverage and alerts. Changes nothing." },
  { userId: "u_nb_deepak", orgId: "org_northbank", journey: "Suspended in Northbank: the password is right but sign-in is refused, and the refusal is a receipt. An owner or admin can reinstate him under People and roles." },
  { userId: "u_kh_arvind", orgId: "org_kaveri", journey: "Review rulebooks, propose an agent’s graduation to A3 for a second person to approve (or approve one someone else proposed), and add a counterparty." },
  { userId: "u_kh_revathi", orgId: "org_kaveri", journey: "Decide held calls, and review the 1 in 10 calls sampled after they run while a graduated agent is in its 30-day supervised period (Agents › Autonomy)." },
  { userId: "u_kh_rafi", orgId: "org_kaveri", journey: "Procurement approver, with Revathi Natarajan; purchases nobody decides within 4 hours escalate to Finance. Also the second person on a graduation proposal: two different people must agree." },
  { userId: "u_kh_sneha", orgId: "org_kaveri", journey: "Data Protection Officer: erasure by salt destruction with a 72-hour clock." },
  { userId: "u_kh_nandini", orgId: "org_kaveri", journey: "Watch at L3: read receipts, counterparty exchanges and autonomy levels. Changes nothing." },
  { userId: "u_dc_prakash", orgId: "org_deccan", journey: "Decide held calls on the bank’s own cluster; receipts are signed in the bank’s HSM." },
  { userId: "u_dc_farhan", orgId: "org_deccan", journey: "Procurement approver, with Prakash Deshpande; vendor payments nobody decides within 4 hours escalate to Finance. Also the second person on a graduation proposal." },
  { userId: "u_dc_meenakshi", orgId: "org_deccan", journey: "Data Protection Officer: erasures, residency proof and the egress log." },
  { userId: "u_dc_sunita", orgId: "org_deccan", journey: "Watch on the bank’s own cluster: read receipts signed in its HSM, the egress log and coverage. Changes nothing." },
];

/** The console's initials: first letters of the first two words, ignoring a "Dr" prefix. */
export function initialsOf(name: string): string {
  return name
    .replace(/^Dr /, "")
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export const CONSOLE_USER_IDS = new Set(CONSOLE_PEOPLE.map((x) => x.id));
