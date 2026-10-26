import { forOrg } from "@gate/db";
import type { Metadata } from "next";
import { Card, PageHeader } from "@/components/ui/layout";
import { env } from "@/server/env";
import { can } from "@/server/policy";
import { requireCtx } from "@/server/session";
import { callbackUrl } from "@/server/sso";
import { SsoForm } from "./form";

export const metadata: Metadata = { title: "Single sign-on" };

export default async function SsoSettings() {
  const ctx = await requireCtx();
  const conn = await forOrg(ctx.org.id).ssoConnection.findFirst();
  const manage = can(ctx.role, "sso:manage");
  return (
    <div className="max-w-[760px]">
      <PageHeader
        back={{ href: "/settings", label: "Settings" }}
        title="Single sign-on"
        description="Let people sign in with your company's identity provider, such as Okta, Microsoft Entra ID or Google Workspace. Elan1 Govern uses OpenID Connect."
      />
      {!manage ? (
        <Card className="p-5 text-sm text-ink-2">{conn?.enabled ? `Single sign-on is on for ${conn.verifiedDomains.join(", ") || "no verified domains yet"}.` : "Single sign-on is off."} Only owners can change it.</Card>
      ) : (
        <SsoForm
          callbackUrl={callbackUrl()}
          webUrl={env().WEB_URL}
          current={
            conn
              ? { issuer: conn.issuer, clientId: conn.clientId, domains: conn.domains, verifiedDomains: conn.verifiedDomains, enforce: conn.enforce, defaultRole: conn.defaultRole, enabled: conn.enabled, verifyToken: conn.verifyToken }
              : null
          }
        />
      )}
    </div>
  );
}
