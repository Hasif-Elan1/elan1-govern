import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Checks an Elan1 Govern webhook. `header` is the `gate-signature` header, `body` the raw request body
 * (as received, before JSON parsing). Rejects signatures older than `toleranceSeconds` (default
 * 5 minutes) to stop replays.
 *
 *   if (!verifyWebhook(process.env.GATE_WEBHOOK_SECRET!, req.headers["gate-signature"], rawBody)) return res.status(400).end();
 */
export function verifyWebhook(secret: string, header: string | null | undefined, body: string | Uint8Array, opts: { toleranceSeconds?: number; now?: number } = {}): boolean {
  if (!secret || typeof header !== "string") return false;
  let t: number | undefined;
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t" && /^\d{1,12}$/.test(v)) t = Number(v);
    if (k === "v1" && /^[0-9a-f]{64}$/.test(v)) sigs.push(v);
  }
  if (t === undefined || !sigs.length) return false;
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (Math.abs(now - t) > (opts.toleranceSeconds ?? 300)) return false;
  const text = typeof body === "string" ? body : Buffer.from(body).toString("utf8");
  const expected = createHmac("sha256", secret).update(`${t}.${text}`).digest();
  return sigs.some((s) => timingSafeEqual(Buffer.from(s, "hex"), expected));
}
