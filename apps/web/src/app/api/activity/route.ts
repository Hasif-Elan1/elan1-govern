import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { activity } from "@/server/queries";

const Query = z.object({
  agent: z.string().max(64).optional(),
  decision: z.enum(["allow", "ask", "refuse", "admin"]).optional(),
  tool: z.string().max(100).optional(),
  from: z.string().max(10).optional(),
  to: z.string().max(10).optional(),
  q: z.string().max(200).optional(),
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const GET = route({ auth: "org", permission: "view" }, async ({ req, ctx }) => {
  const parsed = Query.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) throw new HttpError(400, "Invalid filter.");
  return { items: await activity(ctx.org.id, parsed.data) };
});
