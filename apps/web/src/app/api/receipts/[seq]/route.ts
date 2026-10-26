import { KeyRing, receiptHash, type Receipt } from "@gate/core";
import { forOrg, orgPublicKeys } from "@gate/db";
import { HttpError, route } from "@/server/api";
import { toView } from "@/server/queries";

/** One receipt, plus an independent check of its hash, signature and both chain links. */
export const GET = route({ auth: "org", permission: "view" }, async ({ params, ctx }) => {
  const seq = Number(params.seq);
  if (!Number.isInteger(seq) || seq < 1) throw new HttpError(400, "Invalid receipt number.");
  const db = forOrg(ctx.org.id);
  const [row, prev, next, keys] = await Promise.all([
    db.receipt.findFirst({ where: { seq } }),
    db.receipt.findFirst({ where: { seq: seq - 1 }, select: { hash: true } }),
    db.receipt.findFirst({ where: { seq: seq + 1 }, select: { body: true } }),
    orgPublicKeys(ctx.org.id),
  ]);
  if (!row) throw new HttpError(404, "No receipt with that number.");
  const r = row.body as unknown as Receipt;
  const hashOk = receiptHash(r) === r.hash && row.hash === r.hash;
  // Checked with the key its kid names, which must not have been retired before the receipt.
  const sigOk = new KeyRing(keys).verify(r.hash, r.sig, r.ts, r.kid).ok;
  const prevOk = seq === 1 ? r.prev_hash === `sha256:${"0".repeat(64)}` : prev?.hash === r.prev_hash;
  const nextOk = next ? (next.body as unknown as Receipt).prev_hash === r.hash : null;
  return { receipt: r, view: toView(r), check: { hashOk, sigOk, prevOk, nextOk, ok: hashOk && sigOk && prevOk && nextOk !== false } };
});
