import "server-only";
import { z } from "zod";

export const email = z.string().trim().toLowerCase().email("Enter a valid email address.").max(320);
export const password = z.string().min(1, "Enter your password.").max(200);
export const totp = z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from your app.").optional().or(z.literal("").transform(() => undefined));

/** Only allow redirects back into this app. */
export function safeNext(next: unknown): string {
  return typeof next === "string" && /^\/(?!\/)[\w\-/?=&.%]*$/.test(next) ? next : "/";
}
