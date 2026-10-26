import { hashToken } from "@gate/core";
import { findInviteByTokenHash, forOrg } from "@gate/db";
import type { Metadata } from "next";
import { Wordmark } from "@/components/logo";
import { SignupForm } from "../../(auth)/forms";
import { currentSession } from "@/server/session";
import { AcceptInvite } from "./accept";

export const metadata: Metadata = { title: "Invitation" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await findInviteByTokenHash(hashToken(token));
  const org = invite ? await forOrg(invite.orgId).org.findFirst({ select: { name: true } }) : null;
  const session = await currentSession();
  return (
    <div className="mx-auto flex min-h-dvh max-w-[400px] flex-col px-5 py-8">
      <Wordmark />
      <main className="flex flex-1 flex-col justify-center py-10">
        {!invite || !org ? (
          <>
            <h1 className="text-2xl font-semibold">This invite has expired</h1>
            <p className="mt-2 text-ink-2">Invites work once and last 7 days. Ask whoever invited you to send a new one.</p>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-semibold">Join {org.name}</h1>
            <p className="mt-1.5 mb-7 text-ink-2">
              {invite.invitedBy} invited you as {invite.role}.
            </p>
            {session ? <AcceptInvite token={token} email={invite.email} signedInAs={session.user.email} /> : <SignupForm invite={token} inviteEmail={invite.email} />}
          </>
        )}
      </main>
    </div>
  );
}
