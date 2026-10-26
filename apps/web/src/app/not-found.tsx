import Link from "next/link";
import { Wordmark } from "@/components/logo";

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-[420px] flex-col px-5 py-8">
      <Wordmark />
      <div className="flex flex-1 flex-col justify-center">
        <h1 className="text-2xl font-semibold">That page isn't here</h1>
        <p className="mt-2 text-ink-2">It may have moved, or it belongs to an organisation you're not signed in to.</p>
        <Link href="/" className="mt-6 font-medium text-accent hover:underline">
          Go to Today
        </Link>
      </div>
    </div>
  );
}
