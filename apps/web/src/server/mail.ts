import "server-only";
import nodemailer from "nodemailer";
import { env } from "./env";
import { log } from "./log";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

function transport() {
  return nodemailer.createTransport({ host: env().SMTP_HOST, port: env().SMTP_PORT, secure: env().SMTP_PORT === 465, ignoreTLS: env().SMTP_PORT !== 465 && process.env.APP_ENV !== "production" });
}

/** Best effort: a failed email is logged, and the link is also shown in the app. */
export async function sendInvite(to: string, orgName: string, inviter: string, link: string, role: string) {
  try {
    await transport().sendMail({
      from: env().MAIL_FROM,
      to,
      subject: `${inviter} invited you to ${orgName} on Elan1 Govern`,
      text: `${inviter} invited you to join ${orgName} on Elan1 Govern as ${role}.\n\nAccept: ${link}\n\nThe link works once and expires in 7 days.`,
      html: `<p>${esc(inviter)} invited you to join <b>${esc(orgName)}</b> on Elan1 Govern as ${esc(role)}.</p><p><a href="${esc(link)}">Accept the invite</a></p><p style="color:#6e707a">The link works once and expires in 7 days.</p>`,
    });
  } catch (e) {
    log("warn", "invite email failed", { err: (e as Error).message });
  }
}

/** The password reset link. Never throws: the caller answers the same way whether or not it was sent. */
export async function sendPasswordReset(to: string, name: string, link: string) {
  try {
    await transport().sendMail({
      from: env().MAIL_FROM,
      to,
      subject: "Reset your Elan1 Govern password",
      text: `Hello ${name},\n\nSomeone asked to reset the password for this email on Elan1 Govern. If it was you, choose a new password here:\n\n${link}\n\nThe link works once and expires in 30 minutes. Resetting signs you out everywhere else. If you did not ask, ignore this email: your password stays as it is.`,
      html: `<p>Hello ${esc(name)},</p><p>Someone asked to reset the password for this email on Elan1 Govern. If it was you, choose a new password:</p><p><a href="${esc(link)}">Reset your password</a></p><p style="color:#6e707a">The link works once and expires in 30 minutes. Resetting signs you out everywhere else. If you did not ask, ignore this email: your password stays as it is.</p>`,
    });
  } catch (e) {
    log("warn", "password reset email failed", { err: (e as Error).message });
  }
}
