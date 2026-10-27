import { forOrg } from "@gate/db";
import type { Metadata } from "next";
import { Card, PageHeader, Section } from "@/components/ui/layout";
import { Pill } from "@/components/ui/status";
import { fmtDateTime } from "@/lib/utils";
import { maskedNumber } from "@/lib/notifications";
import { env } from "@/server/env";
import { can } from "@/server/policy";
import { requireCtx } from "@/server/session";
import { ChannelForm, Disconnect, MyNumber } from "./client";

export const metadata: Metadata = { title: "Notifications" };

/** Approvals in Slack and WhatsApp. Chat is a doorbell: rules, decisions and receipts stay in Elan1 Govern. */
export default async function NotificationSettings() {
  const ctx = await requireCtx();
  const db = forOrg(ctx.org.id);
  const manage = can(ctx.role, "notifications:manage");
  const approver = can(ctx.role, "approvals:decide");
  // Never the secrets: only the non-secret config and when it was set up.
  const [channels, number] = await Promise.all([
    db.chatChannel.findMany({ select: { id: true, kind: true, config: true, createdAt: true, createdBy: true } }),
    db.chatNumber.findFirst({ where: { userId: ctx.user.id }, select: { last4: true, verifiedAt: true } }),
  ]);
  const slack = channels.find((c) => c.kind === "slack");
  const whatsapp = channels.find((c) => c.kind === "whatsapp");
  const gateUrl = env().GATE_PUBLIC_URL;
  const cfg = (c: typeof slack) => (c?.config ?? {}) as Record<string, string | undefined>;

  return (
    <div className="max-w-[760px]">
      <PageHeader
        back={{ href: "/settings", label: "Settings" }}
        title="Notifications"
        description="Tell approvers in Slack or WhatsApp when an action is waiting. The rules, the decision and the receipt stay in Elan1 Govern. Emails still go out as before."
      />
      <div className="grid gap-10">
        <Section
          title="Slack"
          description="Elan1 Govern posts each waiting action in one channel. Approve and Reject buttons appear only for rules marked “Can be approved in Slack or WhatsApp”; everything else gets a link to Elan1 Govern."
        >
          <Card className="p-5" data-testid="slack-card">
            {slack ? (
              <div className="grid gap-3 text-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <Pill tone="ok">Connected</Pill>
                  <span>
                    {cfg(slack).teamName ?? cfg(slack).teamId}, channel <code className="font-mono">{cfg(slack).channelId}</code>
                  </span>
                </div>
                <p className="text-ink-3">
                  Interactivity request URL: <code className="font-mono break-all">{`${gateUrl}/chat/slack/${slack.id}/interactions`}</code>
                </p>
                <p className="text-ink-3">
                  Set up {fmtDateTime(slack.createdAt)}
                  {slack.createdBy ? ` by ${slack.createdBy}` : ""}. The bot token and signing secret are stored encrypted and are never shown again.
                </p>
                {manage ? <Disconnect kind="slack" totpEnabled={ctx.user.totpEnabled} /> : null}
              </div>
            ) : manage ? (
              <ChannelForm kind="slack" totpEnabled={ctx.user.totpEnabled} />
            ) : (
              <p className="text-sm text-ink-3">Not connected. An owner or admin can connect Slack.</p>
            )}
          </Card>
        </Section>

        <Section
          title="WhatsApp"
          description="Uses your own WhatsApp Business number through Meta's WhatsApp Cloud API. Each approver adds and verifies their own number below."
        >
          <Card className="p-5" data-testid="whatsapp-card">
            {whatsapp ? (
              <div className="grid gap-3 text-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <Pill tone="ok">Connected</Pill>
                  <span>
                    Phone-number ID <code className="font-mono">{cfg(whatsapp).phoneNumberId}</code>
                    {cfg(whatsapp).templateName ? `, template ${cfg(whatsapp).templateName}` : ", no message template"}
                  </span>
                </div>
                <p className="text-ink-3">
                  Webhook callback URL: <code className="font-mono break-all">{`${gateUrl}/chat/whatsapp/${whatsapp.id}/webhook`}</code>
                </p>
                {!cfg(whatsapp).templateName ? (
                  <p className="text-ink-3">Without an approved template, Meta only delivers messages to approvers who wrote to your business number in the last 24 hours.</p>
                ) : null}
                {manage ? <Disconnect kind="whatsapp" totpEnabled={ctx.user.totpEnabled} /> : null}
              </div>
            ) : manage ? (
              <ChannelForm kind="whatsapp" totpEnabled={ctx.user.totpEnabled} />
            ) : (
              <p className="text-sm text-ink-3">Not connected. An owner or admin can connect WhatsApp.</p>
            )}
          </Card>
        </Section>

        {approver ? (
          <Section title="Your WhatsApp number" description="Get waiting actions on WhatsApp. Elan1 Govern sends a 6-digit code to check the number is yours. Receipts never contain your number.">
            <Card className="p-5">
              <MyNumber
                connected={!!whatsapp}
                current={number ? { masked: maskedNumber(number.last4), verified: !!number.verifiedAt } : null}
              />
            </Card>
          </Section>
        ) : null}
      </div>
    </div>
  );
}
