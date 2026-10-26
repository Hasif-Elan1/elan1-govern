import { hmacVerify } from "@gate/core";
import { forOrg, membershipsForUser, prisma } from "@gate/db";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Wordmark } from "@/components/logo";
import { env } from "@/server/env";
import { currentSession } from "@/server/session";

export const metadata: Metadata = { title: "Approval link" };

type LinkToken = { o: string; a: string; l: string; x: number };

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-[420px] flex-col px-5 py-8">
      <Wordmark />
      <div className="flex flex-1 flex-col justify-center">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="mt-2 text-ink-2">{body}</p>
        <Link href="/approvals" className="mt-6 font-medium text-accent hover:underline">
          Open Approvals
        </Link>
      </div>
    </div>
  );
}

/** Landing page for emailed approval links: check the link, make sure you're signed in, then show the approval. */
export default async function ApproveLink({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = hmacVerify<LinkToken>(env().APPROVAL_LINK_SECRET, decodeURIComponent(token));
  if (!t) return <Message title="This link doesn't work" body="It may have been copied incompletely. Open Approvals in Gate to find the action." />;
  if (t.x * 1000 < Date.now()) return <Message title="This link has expired" body="The action was refused because nobody decided in time." />;
  const link = await forOrg(t.o).approvalLink.findFirst({ where: { id: t.l, approvalId: t.a } });
  if (!link) return <Message title="This link doesn't work" body="Open Approvals in Gate to find the action." />;
  if (link.usedAt) return <Message title="This link was already used" body="Each approval link works once. Open Approvals to see what was decided." />;

  const session = await currentSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(`/approve/${token}`)}`);
  const member = (await membershipsForUser(session.userId)).find((m) => m.orgId === t.o);
  if (!member) return <Message title="This approval is for another organisation" body={`Sign in as ${link.email} to decide it.`} />;
  if (session.activeOrgId !== t.o) await prisma.session.update({ where: { id: session.id }, data: { activeOrgId: t.o } });
  redirect(`/approvals/${t.a}?t=${encodeURIComponent(token)}`);
}
