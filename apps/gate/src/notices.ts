import { forOrg } from "@gate/db";
import type { Deps } from "./deps";
import type { Mail } from "./mailer";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** A short notice email in the same look as the approval email. */
export function noticeEmail(opts: { to: string; kicker: string; title: string; body: string[]; link: string; linkLabel: string; urgent?: boolean }): Mail {
  const text = [opts.title, "", ...opts.body, "", `${opts.linkLabel}: ${opts.link}`].join("\n");
  const button = opts.urgent ? "#b42318" : "#1f3a5f";
  const html = `<!doctype html><html><body style="margin:0;background:#f6f6f4;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1c1c1a">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border:1px solid #e6e5e1;border-radius:12px">
<tr><td style="padding:28px 28px 8px;font-size:13px;color:#6b6a65">Elan1 Govern · ${esc(opts.kicker)}</td></tr>
<tr><td style="padding:0 28px;font-size:20px;font-weight:600;line-height:1.35">${esc(opts.title)}</td></tr>
${opts.body.map((p) => `<tr><td style="padding:12px 28px 0;font-size:14px;color:#4a4945;line-height:1.5">${esc(p)}</td></tr>`).join("\n")}
<tr><td style="padding:24px 28px 28px"><a href="${esc(opts.link)}" style="display:inline-block;background:${button};color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;font-size:14px">${esc(opts.linkLabel)}</a></td></tr>
</table></td></tr></table></body></html>`;
  return { to: opts.to, subject: opts.title, text, html };
}

/** Emails of the org's owners and admins. */
export async function ownersAndAdmins(deps: Deps, orgId: string): Promise<string[]> {
  const rows = await forOrg(orgId, deps.db).membership.findMany({ where: { role: { in: ["owner", "admin"] } }, include: { user: { select: { email: true } } } });
  return [...new Set(rows.map((m) => m.user.email))];
}

/** Sends one mail per recipient; a failure is logged (without the address) and never thrown. */
export async function sendAll(deps: Deps, recipients: string[], build: (to: string) => Mail, what: string, orgId: string) {
  for (const to of recipients) {
    await deps.mailer.send(build(to)).catch((e: Error) => deps.log.warn({ err: e.message, orgId, mail: what }, "notice email failed"));
  }
}
