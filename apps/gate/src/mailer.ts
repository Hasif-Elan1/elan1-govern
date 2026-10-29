import type { Egress } from "@gate/db";
import nodemailer from "nodemailer";
import type { GateEnv } from "./env";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** SMTP is platform-level: the relay is the deployment's own, so its egress check names no organisation. */
export function createMailer(env: GateEnv, egress?: Egress): Mailer {
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    // Mailpit in dev speaks plain SMTP; real relays should use 465 or STARTTLS.
    ignoreTLS: env.NODE_ENV !== "production",
  });
  return {
    async send(mail) {
      await egress?.check({ host: env.SMTP_HOST, port: env.SMTP_PORT }, "smtp");
      await transport.sendMail({ from: env.MAIL_FROM, ...mail });
    },
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export function approvalEmail(opts: { to: string; agent: string; action: string; rule: string; reason: string; link: string; expiresAt: Date }): Mail {
  const when = opts.expiresAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
  const text = [
    `${opts.agent} wants to: ${opts.action}`,
    "",
    `Why it needs you: ${opts.reason} (rule "${opts.rule}")`,
    "",
    `Review it here: ${opts.link}`,
    "",
    `This link works once and expires ${when} IST. If you do nothing, the action is refused.`,
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f6f6f4;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1c1c1a">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border:1px solid #e6e5e1;border-radius:12px">
<tr><td style="padding:28px 28px 8px;font-size:13px;color:#6b6a65">Elan1 Govern · waiting for you</td></tr>
<tr><td style="padding:0 28px;font-size:20px;font-weight:600;line-height:1.35">${esc(opts.action)}</td></tr>
<tr><td style="padding:12px 28px 0;font-size:14px;color:#4a4945;line-height:1.5">Requested by <b>${esc(opts.agent)}</b>. ${esc(opts.reason)}</td></tr>
<tr><td style="padding:24px 28px"><a href="${esc(opts.link)}" style="display:inline-block;background:#1f3a5f;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;font-size:14px">Review and decide</a></td></tr>
<tr><td style="padding:0 28px 28px;font-size:12px;color:#8a8984;line-height:1.5">This link works once and expires ${esc(when)} IST. If nobody decides, the action is refused. Rule: ${esc(opts.rule)}</td></tr>
</table></td></tr></table></body></html>`;
  return { to: opts.to, subject: `Waiting for you: ${opts.action}`, text, html };
}
