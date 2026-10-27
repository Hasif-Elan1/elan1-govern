import { forOrg, orgPublicKeys } from "@gate/db";
import type { Metadata } from "next";
import Link from "next/link";
import { Card, PageHeader, Section } from "@/components/ui/layout";
import { Pill } from "@/components/ui/status";
import { fmtDateTime, relative } from "@/lib/utils";
import { can, ROLE_HINTS, ROLE_LABELS, ROLES } from "@/server/policy";
import { requireCtx } from "@/server/session";
import { InviteForm, MemberRow, OrgForm, TwoStep } from "./client";
import { RotateKey, WebhookForm, WebhookRow, type WebhookView } from "./platform";
import { ReplayStore } from "./replay";

export const metadata: Metadata = { title: "Settings" };

export default async function Settings() {
  const ctx = await requireCtx();
  const db = forOrg(ctx.org.id);
  const manage = can(ctx.role, "settings:manage");
  const hooksAllowed = can(ctx.role, "webhooks:manage");
  const [org, members, invites, keys, agents, signingKeys, hooks] = await Promise.all([
    db.org.findFirstOrThrow(),
    db.membership.findMany({ include: { user: { select: { id: true, email: true, name: true, totpEnabled: true } } }, orderBy: { createdAt: "asc" } }),
    db.invite.findMany({ where: { acceptedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } }),
    manage ? db.apiKey.findMany({ where: { revokedAt: null }, orderBy: { createdAt: "desc" } }) : Promise.resolve([]),
    db.agent.findMany({ select: { id: true, slug: true, name: true } }),
    orgPublicKeys(ctx.org.id),
    hooksAllowed
      ? db.webhook.findMany({ orderBy: { createdAt: "asc" }, include: { deliveries: { orderBy: { createdAt: "desc" }, take: 5 } } })
      : Promise.resolve([]),
  ]);
  const webhooks: WebhookView[] = hooks.map((h) => ({
    id: h.id,
    url: h.url,
    events: h.events,
    active: h.active,
    createdAt: h.createdAt.toISOString(),
    deliveries: h.deliveries.map((d) => ({ id: d.id, event: d.event, status: d.status, attempts: d.attempts, lastError: d.lastError, responseStatus: d.responseStatus, createdAt: d.createdAt.toISOString(), deliveredAt: d.deliveredAt?.toISOString() ?? null })),
  }));
  const activeKey = signingKeys.find((k) => !k.retiredAt) ?? signingKeys.at(-1);

  return (
    <>
      <PageHeader title="Settings" description={manage ? "Your organisation, the people in it, and how long Elan1 Govern keeps records." : "Your organisation and your own sign-in security. Only owners and admins can change organisation settings."} />
      <div className="grid gap-12">
        <Section title="Organisation">
          <Card className="p-5">
            <OrgForm name={org.name} notifyEmail={org.notifyEmail ?? ""} retentionDays={org.retentionDays} disabled={!manage} />
          </Card>
        </Section>

        <Section title="Past actions for testing rules" description="So you can test a rulebook change on what your agents actually did, Elan1 Govern keeps each call's details for 30 days, encrypted. Receipts never hold them.">
          <Card className="p-5">
            <ReplayStore on={org.replayStore} disabled={!manage} />
          </Card>
        </Section>

        <Section title="Members and roles" description="Approvers decide waiting actions. Auditors see everything and download evidence, and can belong to several organisations, such as an outside auditor or accountant.">
          <Card className="divide-y divide-line">
            {members.map((m) => (
              <MemberRow
                key={m.id}
                userId={m.user.id}
                name={m.user.name}
                email={m.user.email}
                role={m.role}
                twoStep={m.user.totpEnabled}
                you={m.user.id === ctx.user.id}
                canManage={can(ctx.role, "members:manage") && m.user.id !== ctx.user.id}
                actorRole={ctx.role}
              />
            ))}
            {invites.map((i) => (
              <div key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <span className="flex-1 text-ink-2">{i.email}</span>
                <Pill tone="wait">Invited as {ROLE_LABELS[i.role]}</Pill>
              </div>
            ))}
          </Card>
          {can(ctx.role, "members:manage") ? (
            <div className="mt-4">
              <InviteForm actorRole={ctx.role} />
            </div>
          ) : null}
          <ul className="mt-4 grid gap-1 text-[13px] text-ink-3 sm:grid-cols-2">
            {ROLES.map((r) => (
              <li key={r}>
                <span className="font-medium text-ink-2">{ROLE_LABELS[r]}:</span> {ROLE_HINTS[r]}
              </li>
            ))}
          </ul>
        </Section>

        {manage ? (
          <Section title="API keys" description="Active keys for all agents. Elan1 Govern shows a key once when it is made and keeps only its hash.">
            {keys.length ? (
              <Card className="divide-y divide-line text-sm">
                {keys.map((k) => {
                  const a = agents.find((x) => x.id === k.agentId);
                  return (
                    <div key={k.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                      <code className="font-mono text-[13px]">{k.prefix}…</code>
                      <span className="flex-1">{a?.name}</span>
                      <span className="text-ink-3">Last used {relative(k.lastUsedAt).toLowerCase()}</span>
                      <Link href={`/agents/${a?.slug}`} className="font-medium text-accent hover:underline">
                        Manage
                      </Link>
                    </div>
                  );
                })}
              </Card>
            ) : (
              <p className="text-sm text-ink-3">No active keys. Each agent gets one when you add it.</p>
            )}
          </Section>
        ) : null}

        <Section title="Single sign-on" description="Sign in with your company's identity provider (OpenID Connect).">
          <Card className="flex flex-wrap items-center justify-between gap-3 p-5 text-sm">
            <span className="text-ink-2">Okta, Microsoft Entra ID, Google Workspace, Auth0, Keycloak and others.</span>
            <Link href="/settings/sso" className="font-medium text-accent hover:underline">
              Set up single sign-on
            </Link>
          </Card>
        </Section>

        <Section title="Notifications" description="Approvals in Slack and WhatsApp, as well as email. Rules, decisions and receipts stay in Elan1 Govern.">
          <Card className="flex flex-wrap items-center justify-between gap-3 p-5 text-sm">
            <span className="text-ink-2">Connect Slack or WhatsApp, and add your own WhatsApp number.</span>
            <Link href="/settings/notifications" className="font-medium text-accent hover:underline">
              Set up notifications
            </Link>
          </Card>
        </Section>

        {hooksAllowed ? (
          <Section title="Webhooks" description="Send receipts and approval events to your SIEM, log store or other tools. Each request is signed with a secret only you and Elan1 Govern know.">
            <div className="grid gap-3">
              {webhooks.map((h) => (
                <WebhookRow key={h.id} hook={h} />
              ))}
              {!webhooks.length ? <p className="text-sm text-ink-3">No endpoints yet.</p> : null}
              <Card className="p-5">
                <WebhookForm />
              </Card>
            </div>
          </Section>
        ) : null}

        <Section
          title="Signing keys"
          description="Elan1 Govern signs every receipt, checkpoint and evidence bundle with your organisation's key. Retired keys are kept so older evidence still checks out."
          actions={can(ctx.role, "keys:rotate") && activeKey ? <RotateKey current={activeKey.kid} totpEnabled={ctx.user.totpEnabled} /> : null}
        >
          <Card className="divide-y divide-line text-sm">
            {[...signingKeys].reverse().map((k) => (
              <div key={k.kid} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                <code className="font-mono text-[13px]">{k.kid}</code>
                <span className="flex-1 text-ink-3">Created {fmtDateTime(k.createdAt)}</span>
                {k.retiredAt ? <Pill>Retired {fmtDateTime(k.retiredAt)}</Pill> : <Pill tone="ok">In use</Pill>}
              </div>
            ))}
          </Card>
          {!can(ctx.role, "keys:rotate") ? <p className="mt-2 text-[13px] text-ink-3">Only owners can rotate the signing key.</p> : null}
        </Section>

        <Section title="Your sign-in" description="Two-step sign-in asks for a code from an authenticator app, such as Google Authenticator, when you sign in and before you approve.">
          <Card className="p-5">
            <TwoStep enabled={ctx.user.totpEnabled} />
          </Card>
        </Section>
      </div>
    </>
  );
}
