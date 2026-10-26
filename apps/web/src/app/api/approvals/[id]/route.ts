import { hmacVerify } from "@gate/core";
import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { env } from "@/server/env";
import { gate } from "@/server/gate";
import { LIMITS } from "@/server/ratelimit";

const Body = z
  .object({
    result: z.enum(["approved", "rejected"]),
    note: z.string().trim().max(1000).optional(),
    token: z.string().max(600).optional(),
  })
  .strict();

type LinkToken = { o: string; a: string; l: string; x: number };

/**
 * Approve or reject. Needs the approver role, a sign-in within the last 10 minutes, and
 * (checked again by Elan1 Govern) a place on the rule's approver list. An emailed link adds a
 * single-use, expiring token.
 */
export const POST = route(
  { auth: "org", permission: "approvals:decide", fresh: true, body: Body, limit: { name: "approvals", ...LIMITS.approvals } },
  async ({ body, params, ctx }) => {
    let linkId: string | undefined;
    if (body.token) {
      const t = hmacVerify<LinkToken>(env().APPROVAL_LINK_SECRET, body.token);
      if (!t || t.o !== ctx.org.id || t.a !== params.id) throw new HttpError(400, "This approval link is not valid for this action.");
      if (t.x * 1000 < Date.now()) throw new HttpError(410, "This approval link has expired.");
      linkId = t.l;
    }
    const r = await gate<{ ok: boolean; status?: string; outcome?: { status: string; ref?: string; error?: string }; message?: string; selfApproval?: boolean }>(
      "POST",
      `/internal/orgs/${ctx.org.id}/approvals/${encodeURIComponent(params.id ?? "")}/resolve`,
      { userId: ctx.user.id, email: ctx.user.email, result: body.result, ...(body.note ? { note: body.note } : {}), ...(linkId ? { linkId } : {}) },
    );
    if (r.status !== 200) throw new HttpError(r.status === 404 ? 404 : r.status >= 500 ? 502 : r.status, r.data.message ?? "Elan1 Govern could not record the decision.");
    return { status: r.data.status, outcome: r.data.outcome, selfApproval: r.data.selfApproval };
  },
);
