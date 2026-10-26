import { z } from "zod";

// Request and response shapes of the agent-facing REST API. The routes validate with these
// and docs/openapi.json is generated from them (see openapi.ts).

export const CheckBody = z
  .object({
    tool: z.string().min(1).max(100).meta({ description: "Tool name, e.g. zoho.record_bill_payment.", examples: ["zoho.record_bill_payment"] }),
    args: z.record(z.string(), z.unknown()).default({}).meta({ description: "The tool's arguments. Validated against the tool's schema." }),
  })
  .strict();

export const RecordBody = z
  .object({
    check_id: z.number().int().positive().optional().meta({ description: "The check_id of an allowed check. Give this or approval_id." }),
    approval_id: z.string().max(64).optional().meta({ description: "The id of an approved action the agent runs itself. Give this or check_id." }),
    status: z.enum(["ok", "error"]),
    ref: z.string().max(200).optional().meta({ description: "Your reference for what happened, e.g. a payment id." }),
    error: z.string().max(500).optional(),
  })
  .strict()
  .refine((b) => (b.check_id === undefined) !== (b.approval_id === undefined), "give exactly one of check_id or approval_id");

const base = {
  rule_id: z.string().meta({ description: "The rule that decided, or default." }),
  reason: z.string(),
  check_id: z.number().int().nullable().meta({ description: "Seq of the decision receipt. Pass it to /v1/record after running an allowed action." }),
};

export const CheckResponse = z
  .discriminatedUnion("decision", [
    z.object({ decision: z.literal("allow"), ...base }).strict(),
    z
      .object({
        decision: z.literal("ask"),
        ...base,
        approval_id: z.string(),
        approval_url: z.string().meta({ description: "Where a person decides." }),
        expires_at: z.string().meta({ description: "ISO 8601 time after which the action is refused." }),
      })
      .strict(),
    z.object({ decision: z.literal("refuse"), ...base }).strict(),
  ]);

export const RecordResponse = z.object({ recorded: z.literal(true), receipt_seq: z.number().int() }).strict();

export const ApprovalStatusResponse = z
  .object({
    approval_id: z.string(),
    status: z.enum(["pending", "approved", "rejected", "expired"]),
    expires_at: z.string(),
    rule_id: z.string(),
    message: z.string().meta({ description: "What to do next, in plain words." }),
    outcome: z.object({ status: z.string(), ref: z.string().optional(), error: z.string().optional() }).optional().meta({ description: "For actions Gate ran: how it went." }),
    result: z.unknown().optional().meta({ description: "For actions Gate ran: the tool's result." }),
  });

export const ErrorResponse = z.object({ error: z.string().meta({ description: "A plain-English message." }) });

export const ApprovalParams = z.object({ id: z.string().max(64) });
export const ApprovalQuery = z.object({ wait: z.coerce.number().min(0).max(30).default(0) });
