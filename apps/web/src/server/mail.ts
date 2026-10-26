import "server-only";
import nodemailer from "nodemailer";
import { env } from "./env";
import { log } from "./log";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** Best effort: a failed email is logged, and the link is also shown in the app. */
export async function sendInvite(to: string, orgName: string, inviter: string, link: string, role: string) {
  try {
    const t = nodemailer.createTransport({ host: env().SMTP_HOST, port: env().SMTP_PORT, secure: env().SMTP_PORT === 465, ignoreTLS: env().SMTP_PORT !== 465 && process.env.APP_ENV !== "production" });
    await t.sendMail({
      from: env().MAIL_FROM,
      to,
      subject: `${inviter} invited you to ${orgName} on Gate`,
      text: `${inviter} invited you to join ${orgName} on Gate as ${role}.\n\nAccept: ${link}\n\nThe link works once and expires in 7 days.`,
      html: `<p>${esc(inviter)} invited you to join <b>${esc(orgName)}</b> on Gate as ${esc(role)}.</p><p><a href="${esc(link)}">Accept the invite</a></p><p style="color:#6e707a">The link works once and expires in 7 days.</p>`,
    });
  } catch (e) {
    log("warn", "invite email failed", { err: (e as Error).message });
  }
}
