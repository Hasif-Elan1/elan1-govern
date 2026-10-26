import { Wordmark } from "@/components/logo";
import { Stamp } from "@/components/ui/status";

/** A sample receipt: the thing Elan1 Govern produces, shown beside sign-in on wide screens. */
function SampleReceipt() {
  return (
    <div className="w-full max-w-[360px]">
      <div className="slip px-6 pt-7 pb-6 shadow-[0_24px_60px_-30px_rgba(20,20,40,0.35)]">
        <div className="flex items-start justify-between gap-3">
          <p className="text-[13px] text-ink-3">Receipt 1042</p>
          <Stamp kind="approved" />
        </div>
        <p className="mt-4 text-[17px] leading-snug font-semibold">Pay ₹2,00,000 to Sharma Traders for INV-2291</p>
        <dl className="mt-5 grid grid-cols-[96px_1fr] gap-y-2 text-[13px]">
          <dt className="text-ink-3">Agent</dt>
          <dd>ap-bot</dd>
          <dt className="text-ink-3">Rule</dt>
          <dd className="font-mono text-[12px]">pay-large</dd>
          <dt className="text-ink-3">Approved by</dt>
          <dd>priya@acme.in</dd>
          <dt className="text-ink-3">Result</dt>
          <dd>Done, PAY-8812</dd>
        </dl>
        <div className="mt-5 border-t border-dashed border-line-2 pt-3 font-mono text-[11.5px] leading-relaxed text-ink-3">
          <p>prev 9f3c1a…e07b</p>
          <p>hash 4b81d2…a913</p>
          <p>sig ed25519:Q2xp…</p>
        </div>
      </div>
      <p className="mt-6 text-sm leading-relaxed text-ink-2">
        Every action an agent tries gets a receipt like this one: who asked, which rule decided, who approved. Each receipt is signed and chained to the one before it, so nobody can quietly change history.
      </p>
    </div>
  );
}

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[1fr_minmax(440px,44%)]">
      <div className="flex min-h-dvh flex-col px-4 py-8 sm:px-6">
        <div className="mx-auto w-full max-w-[400px]">
          <Wordmark />
        </div>
        <main className="mx-auto flex w-full max-w-[400px] flex-1 flex-col justify-center py-10">{children}</main>
        <p className="mx-auto max-w-[400px] text-center text-[13px] text-ink-3 lg:hidden">Every action your agents take is checked, and every decision is signed.</p>
      </div>
      <aside className="hidden items-center justify-center border-l border-line bg-sunken px-12 lg:flex" aria-label="What Elan1 Govern records">
        <SampleReceipt />
      </aside>
    </div>
  );
}
