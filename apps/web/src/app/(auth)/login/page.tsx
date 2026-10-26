import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentSession } from "@/server/session";
import { LoginForm } from "../forms";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  if (await currentSession()) redirect(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
  return (
    <>
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <p className="mt-1.5 mb-7 text-ink-2">Approve waiting actions and see what your agents did.</p>
      <LoginForm next={next} />
    </>
  );
}
