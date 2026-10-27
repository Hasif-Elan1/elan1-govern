import { randomBytes } from "node:crypto";
import { decrypt, describeAction, encrypt, hmacSign, type DecisionResult, type Receipt, type ReceiptInput } from "@gate/core";
import { dueApprovals, forOrg } from "@gate/db";
import { background, chain } from "./chain";
import type { DecisionChannel } from "./chat/common";
import { chatResolved, notifyChat } from "./chat/outbox";
import { publicError, resolveConnectorFor, type Resolved } from "./connectors";
import { registryFor } from "./registry";
import { raiseAlert, type Deps } from "./deps";
import type { GuardResult } from "./guard";
import { approvalEmail } from "./mailer";

const argsAad = (id: string) => `approval-args:${id}`;
const APPROVER_ROLES = new Set(["owner", "admin", "approver"]);

export function approvalUrl(deps: Deps, id: string) {
  return `${deps.env.WEB_URL}/approvals/${id}`;
}

/** Signed, single-use link for one approver. The DB row makes it single-use; the HMAC makes it unforgeable. */
export function approvalLinkToken(deps: Deps, orgId: string, approvalId: string, linkId: string, expiresAt: Date) {
  return hmacSign(deps.env.APPROVAL_LINK_SECRET, { o: orgId, a: approvalId, l: linkId, x: Math.floor(expiresAt.getTime() / 1000) });
}

export async function holdForApproval(
  deps: Deps,
  input: {
    orgId: string;
    agentId: string;
    agentName: string;
    tool: string;
    args: Record<string, unknown>;
    receipt: ReceiptInput;
    decision: DecisionResult;
    connector?: Resolved;
    executor: "gate" | "agent";
    /** The deciding rule lets approvers decide in Slack or WhatsApp (see chatApprovalAllowed). */
    chatApproval?: boolean;
  },
): Promise<GuardResult> {
  const { orgId, decision: d } = input;
  const id = `apr_${randomBytes(12).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + (d.expiresInMs ?? 86_400_000));
  const approvers = (d.approvers ?? []).map((e) => e.toLowerCase());
  const evidence = input.connector?.ok
    ? await input.connector.connector.evidence(input.tool, input.args, input.connector.ctx).catch(() => ({}))
    : {};

  const { receipt, links } = await chain(
    deps,
    orgId,
    async (append, tx) => {
      const receipt = await append({ ...input.receipt, decision: "ask", approval: { id, result: "pending", expires_at: expiresAt.toISOString() } });
      await tx.approval.create({
        data: {
          id,
          orgId,
          agentId: input.agentId,
          tool: input.tool,
          argsEnc: encrypt(deps.env.GATE_MASTER_KEY, JSON.stringify(input.args), argsAad(id)),
          argsSummary: (input.receipt.args_summary ?? {}) as object,
          ruleId: d.ruleId,
          reason: d.reason,
          approverGroup: d.approverGroup ?? "",
          approvers,
          evidence: evidence as object,
          heldSeq: receipt.seq,
          expiresAt,
          executor: input.executor,
          chatApproval: input.chatApproval === true,
        },
      });
      const links = [];
      for (const email of approvers) links.push(await tx.approvalLink.create({ data: { orgId, approvalId: id, email, expiresAt } }));
      return { receipt, links };
    },
  );

  const action = describeAction(input.tool, input.receipt.args_summary ?? {});
  for (const link of links) {
    const mail = approvalEmail({
      to: link.email,
      agent: input.agentName,
      action,
      rule: d.ruleId,
      reason: d.reason,
      link: `${deps.env.WEB_URL}/approve/${approvalLinkToken(deps, orgId, id, link.id, expiresAt)}`,
      expiresAt,
    });
    await deps.mailer.send(mail).catch((e: Error) => deps.log.warn({ err: e.message, approvalId: id }, "approval email failed"));
  }
  // Slack and WhatsApp are queued in the background: the guard never waits for them.
  background(deps, notifyChat(deps, orgId, id));

  return { status: "pending", ruleId: d.ruleId, reason: d.reason, seq: receipt.seq, approvalId: id, expiresAt: expiresAt.toISOString(), approvalUrl: approvalUrl(deps, id) };
}

async function heldReceipt(deps: Deps, orgId: string, seq: number): Promise<Receipt> {
  const row = await forOrg(orgId, deps.db).receipt.findFirstOrThrow({ where: { seq } });
  return row.body as unknown as Receipt;
}

function followUp(held: Receipt, approval: NonNullable<ReceiptInput["approval"]>, outcome: NonNullable<ReceiptInput["outcome"]>, details?: Record<string, unknown>): ReceiptInput {
  return {
    kind: "approval",
    agent: held.agent,
    tool: held.tool,
    args_summary: held.args_summary,
    args_hash: held.args_hash,
    rulebook: held.rulebook,
    rule_id: held.rule_id,
    decision: "ask",
    reason: held.reason,
    approval,
    outcome,
    ref_seq: held.seq,
    ...(details ? { details } : {}),
  };
}

export type ResolveError = { ok: false; code: "not_found" | "not_pending" | "expired" | "not_approver" | "link_invalid" | "app_only"; message: string };
export type ResolveResult = { ok: true; status: "approved" | "rejected"; outcome: { status: string; ref?: string; error?: string }; selfApproval: boolean } | ResolveError;

export async function resolveApproval(
  deps: Deps,
  orgId: string,
  approvalId: string,
  input: { userId: string; email: string; result: "approved" | "rejected"; note?: string; linkId?: string; channel?: DecisionChannel; channelUser?: string },
): Promise<ResolveResult> {
  // Every decision, from the web, an email link, Slack or WhatsApp, comes through here.
  const channel: DecisionChannel = input.channel ?? (input.linkId ? "email" : "web");
  const inChat = channel === "slack" || channel === "whatsapp";
  const db = forOrg(orgId, deps.db);
  const email = input.email.toLowerCase();
  const approval = await db.approval.findFirst({ where: { id: approvalId } });
  if (!approval) return { ok: false, code: "not_found", message: "No such approval." };
  if (approval.status !== "pending") return { ok: false, code: "not_pending", message: `This was already ${approval.status}.` };
  if (approval.expiresAt <= new Date()) {
    await expireApproval(deps, orgId, approvalId);
    return { ok: false, code: "expired", message: "This approval expired, so the action was refused." };
  }
  const member = await db.membership.findFirst({ where: { userId: input.userId } });
  if (!member || !APPROVER_ROLES.has(member.role) || !approval.approvers.includes(email)) {
    return { ok: false, code: "not_approver", message: "You are not one of the approvers for this rule." };
  }
  if (inChat && !approval.chatApproval) return { ok: false, code: "app_only", message: "This action can only be approved in Elan1 Govern." };
  const agent = await db.agent.findFirstOrThrow({ where: { id: approval.agentId } });
  const selfApproval = agent.createdById === input.userId;
  const now = new Date();

  try {
    await db.$transaction(async (tx) => {
      if (input.linkId) {
        const used = await tx.approvalLink.updateMany({
          where: { id: input.linkId, approvalId, email, usedAt: null, expiresAt: { gt: now } },
          data: { usedAt: now },
        });
        if (used.count !== 1) throw new LinkError();
      }
      const claimed = await tx.approval.updateMany({
        where: { id: approvalId, status: "pending", expiresAt: { gt: now } },
        data: { status: input.result, resolvedBy: email, note: input.note ?? null, selfApproval, resolvedAt: now, channel, channelUser: inChat ? (input.channelUser ?? null) : null },
      });
      if (claimed.count !== 1) throw new ClaimError();
    });
  } catch (e) {
    if (e instanceof LinkError) return { ok: false, code: "link_invalid", message: "This link was already used or has expired." };
    if (e instanceof ClaimError) return { ok: false, code: "not_pending", message: "Someone else already decided this." };
    throw e;
  }

  const held = await heldReceipt(deps, orgId, approval.heldSeq);
  const decided = { id: approvalId, result: input.result, by: email, at: now.toISOString(), ...(selfApproval ? { self_approval: true } : {}) };

  let outcome: NonNullable<ReceiptInput["outcome"]> = { status: "not_run" };
  let data: unknown;
  if (input.result === "approved" && approval.executor === "gate" && approval.argsEnc) {
    const args = JSON.parse(decrypt(deps.env.GATE_MASTER_KEY, approval.argsEnc, argsAad(approvalId))) as Record<string, unknown>;
    const spec = (await registryFor(deps, orgId)).get(approval.tool);
    const conn: Resolved = spec ? await resolveConnectorFor(deps, orgId, spec) : { ok: false, reason: `${approval.tool} is no longer available` };
    if (!conn.ok) outcome = { status: "error", error: conn.reason };
    else {
      try {
        const res = await conn.connector.call(approval.tool, args, conn.ctx);
        outcome = { status: "ok", ...(res.ref ? { ref: res.ref } : {}) };
        data = res.data;
      } catch (e) {
        outcome = { status: "error", error: publicError(e) };
      }
    }
  }

  try {
    await chain(
      deps,
      orgId,
      async (append, tx) => {
        await append(followUp(held, decided, outcome, { channel, ...(inChat && input.channelUser ? { channel_user: input.channelUser } : {}) }));
        await tx.approval.update({ where: { id: approvalId }, data: { argsEnc: null, result: { ...outcome, ...(data !== undefined ? { data } : {}) } as object } });
      },
    );
  } catch (e) {
    await raiseAlert(deps, "receipt-write-failed", `Approval ${approvalId} was ${input.result} (${outcome.status}) but its receipt could not be written: ${(e as Error).message}`, orgId);
  }
  background(deps, chatResolved(deps, orgId, approvalId));
  return { ok: true, status: input.result, outcome, selfApproval };
}

class LinkError extends Error {}
class ClaimError extends Error {}

/** Expire one approval if it is pending and past its time. Returns true when it expired it. */
export async function expireApproval(deps: Deps, orgId: string, approvalId: string): Promise<boolean> {
  const expired = await chain(
    deps,
    orgId,
    async (append, tx) => {
      const now = new Date();
      const claimed = await tx.approval.updateMany({ where: { id: approvalId, status: "pending", expiresAt: { lte: now } }, data: { status: "expired", resolvedAt: now, argsEnc: null } });
      if (claimed.count !== 1) return false;
      const a = await tx.approval.findFirstOrThrow({ where: { id: approvalId } });
      const row = await tx.receipt.findFirstOrThrow({ where: { seq: a.heldSeq } });
      await append(followUp(row.body as unknown as Receipt, { id: approvalId, result: "expired", at: now.toISOString() }, { status: "not_run" }));
      return true;
    },
  );
  if (expired) background(deps, chatResolved(deps, orgId, approvalId));
  return expired;
}

export interface ApprovalStatus {
  approval_id: string;
  status: "pending" | "approved" | "rejected" | "expired";
  expires_at: string;
  rule_id: string;
  message: string;
  outcome?: unknown;
  result?: unknown;
}

function statusOf(a: { id: string; status: ApprovalStatus["status"]; expiresAt: Date; ruleId: string; result: unknown; resolvedBy: string | null; executor: string }): ApprovalStatus {
  const r = (a.result ?? undefined) as { status?: string; ref?: string; error?: string; data?: unknown } | undefined;
  const message = {
    pending: "Still waiting for a person to decide.",
    approved: a.executor === "agent" ? `Approved by ${a.resolvedBy}. You may run the action now, then record the outcome.` : !r ? `Approved by ${a.resolvedBy}. Elan1 Govern is running it now; ask again for the result.` : r.status === "ok" ? `Approved by ${a.resolvedBy} and done.` : `Approved by ${a.resolvedBy}, but it did not complete: ${r.error ?? "unknown error"}.`,
    rejected: `Rejected by ${a.resolvedBy}. Do not retry this action.`,
    expired: "Nobody decided in time, so the action was refused.",
  }[a.status];
  return {
    approval_id: a.id,
    status: a.status,
    expires_at: a.expiresAt.toISOString(),
    rule_id: a.ruleId,
    message,
    ...(r ? { outcome: { status: r.status, ref: r.ref, error: r.error } } : {}),
    ...(r?.data !== undefined ? { result: r.data } : {}),
  };
}

/** Long-poll: returns as soon as the approval is decided, or after `waitSeconds` (max 30). */
export async function waitForApproval(deps: Deps, orgId: string, agentId: string, approvalId: string, waitSeconds: number): Promise<ApprovalStatus | null> {
  const db = forOrg(orgId, deps.db);
  const deadline = Date.now() + Math.min(Math.max(waitSeconds, 0), 30) * 1000;
  for (;;) {
    const a = await db.approval.findFirst({ where: { id: approvalId, agentId } });
    if (!a) return null;
    if (a.status === "pending" && a.expiresAt <= new Date()) {
      await expireApproval(deps, orgId, approvalId);
      continue;
    }
    // An approved call that Elan1 Govern runs is "settled" only once its result is stored.
    const running = a.status === "approved" && a.executor === "gate" && a.result === null;
    if ((a.status !== "pending" && !running) || Date.now() >= deadline) return statusOf(a);
    await new Promise((r) => setTimeout(r, 300));
  }
}

export async function expireDue(deps: Deps): Promise<number> {
  let n = 0;
  for (const a of await dueApprovals(new Date(), deps.db)) {
    if (await expireApproval(deps, a.orgId, a.id).catch(() => false)) n++;
  }
  return n;
}
