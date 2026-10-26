import Link from "next/link";
import * as React from "react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "./button";

export function PageHeader({ title, description, actions, back }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; back?: { href: string; label: string } }) {
  return (
    <header className="mb-7">
      {back ? (
        <Link href={back.href} className="mb-3 inline-block text-sm text-ink-3 hover:text-ink">
          ← {back.label}
        </Link>
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[26px] leading-tight font-semibold">{title}</h1>
          {description ? <p className="mt-1.5 max-w-[62ch] text-ink-2">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border border-line bg-surface", className)} {...props} />;
}

export function Section({ title, description, actions, children, className }: { title: string; description?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={className}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold">{title}</h2>
          {description ? <p className="mt-0.5 text-sm text-ink-2">{description}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Every empty view says what to do next, with one button. */
export function EmptyState({ icon, title, body, action }: { icon?: React.ReactNode; title: string; body: React.ReactNode; action?: { href: string; label: string } | React.ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-line-2 px-6 py-12 text-center">
      {icon ? <div className="mb-3 text-ink-3 [&_svg]:size-6">{icon}</div> : null}
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="mt-1 max-w-[46ch] text-sm text-ink-2">{body}</p>
      {action ? (
        <div className="mt-5">
          {typeof action === "object" && action !== null && "href" in (action as object) ? (
            <Link href={(action as { href: string }).href} className={buttonVariants({ variant: "primary" })}>
              {(action as { label: string }).label}
            </Link>
          ) : (
            (action as React.ReactNode)
          )}
        </div>
      ) : null}
    </div>
  );
}

export function KeyValue({ items, className }: { items: [string, React.ReactNode][]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[minmax(110px,auto)_1fr] gap-x-6 gap-y-2.5 text-sm", className)}>
      {items.map(([k, v]) => (
        <React.Fragment key={k}>
          <dt className="text-ink-3">{k}</dt>
          <dd className="min-w-0 break-words text-ink">{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}
