import "server-only";
import { decrypt, encrypt } from "@gate/core";
import { prisma } from "@gate/db";
import argon2 from "argon2";
import * as OTPAuth from "otpauth";
import { env } from "./env";

// A real hash to compare against when the email is unknown, so timing does not reveal it.
let dummyHash: Promise<string> | undefined;
const dummy = () => (dummyHash ??= argon2.hash("not-a-real-password-just-for-timing", { type: argon2.argon2id }));

export const PASSWORD_RULE = "Use at least 12 characters.";

export function passwordProblem(pw: string): string | null {
  if (pw.length < 12) return PASSWORD_RULE;
  if (pw.length > 200) return "Use at most 200 characters.";
  if (/^(.)\1+$/.test(pw) || /^(?:password|123456789012|qwertyuiopas)/i.test(pw)) return "Choose a password that is harder to guess.";
  return null;
}

export function hashPassword(pw: string) {
  return argon2.hash(pw, { type: argon2.argon2id });
}

const MAX_FAILURES = 5;

/** Lockout after 5 failures: 1 minute, doubling each further failure, up to an hour. */
export function lockoutMs(failures: number): number {
  if (failures < MAX_FAILURES) return 0;
  return Math.min(60 * 60_000, 60_000 * 2 ** (failures - MAX_FAILURES));
}

export type LoginResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "invalid" | "locked" | "totp_required" | "totp_invalid"; retryAfter?: number };

export async function checkPassword(email: string, password: string, totp?: string): Promise<LoginResult> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) {
    await argon2.verify(await dummy(), password).catch(() => false);
    return { ok: false, reason: "invalid" };
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    return { ok: false, reason: "locked", retryAfter: Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000) };
  }
  const good = await argon2.verify(user.passwordHash, password).catch(() => false);
  if (!good) {
    const failures = user.failedLogins + 1;
    const ms = lockoutMs(failures);
    await prisma.user.update({ where: { id: user.id }, data: { failedLogins: failures, lockedUntil: ms ? new Date(Date.now() + ms) : null } });
    return ms ? { ok: false, reason: "locked", retryAfter: Math.ceil(ms / 1000) } : { ok: false, reason: "invalid" };
  }
  if (user.totpEnabled && user.totpSecret) {
    if (!totp) return { ok: false, reason: "totp_required" };
    if (!verifyTotp(user.totpSecret, totp)) {
      await prisma.user.update({ where: { id: user.id }, data: { failedLogins: user.failedLogins + 1 } });
      return { ok: false, reason: "totp_invalid" };
    }
  }
  await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } });
  return { ok: true, userId: user.id };
}

// ---- TOTP (RFC 6238), secret encrypted at rest ----

const totpAad = "totp";

export function newTotp(email: string) {
  const secret = new OTPAuth.Secret({ size: 20 });
  const t = new OTPAuth.TOTP({ issuer: "Elan1 Govern", label: email, secret, algorithm: "SHA1", digits: 6, period: 30 });
  return { uri: t.toString(), secretEnc: encrypt(env().WEB_ENC_KEY, secret.base32, totpAad) };
}

export function verifyTotp(secretEnc: string, code: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const secret = OTPAuth.Secret.fromBase32(decrypt(env().WEB_ENC_KEY, secretEnc, totpAad));
  const t = new OTPAuth.TOTP({ secret, algorithm: "SHA1", digits: 6, period: 30 });
  return t.validate({ token: code, window: 1 }) !== null;
}

export function totpNow(secretEnc: string): string {
  const secret = OTPAuth.Secret.fromBase32(decrypt(env().WEB_ENC_KEY, secretEnc, totpAad));
  return new OTPAuth.TOTP({ secret, algorithm: "SHA1", digits: 6, period: 30 }).generate();
}
