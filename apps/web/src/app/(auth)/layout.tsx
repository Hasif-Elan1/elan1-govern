import { Wordmark } from "@/components/logo";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col px-4 py-8 sm:px-6">
      <div className="mx-auto w-full max-w-[400px]">
        <Wordmark />
      </div>
      <main className="mx-auto flex w-full max-w-[400px] flex-1 flex-col justify-center py-10">{children}</main>
      <p className="mx-auto max-w-[400px] text-center text-[13px] text-ink-3">Every action your agents take is checked, and every decision is signed.</p>
    </div>
  );
}
