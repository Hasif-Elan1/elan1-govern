"use client";

import { Activity, Bot, BookText, Check, ChevronsUpDown, FileCheck2, Inbox, LogOut, Menu, Monitor, Moon, Plug, Settings, Sun, SunMedium } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { DropdownMenu as DM, Dialog as D } from "radix-ui";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";
import { Logo } from "./logo";

const NAV = [
  { href: "/", label: "Today", icon: SunMedium },
  { href: "/approvals", label: "Approvals", icon: Inbox, badge: true },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/rulebooks", label: "Rulebooks", icon: BookText },
  { href: "/connectors", label: "Connectors", icon: Plug },
  { href: "/evidence", label: "Evidence", icon: FileCheck2 },
  { href: "/settings", label: "Settings", icon: Settings },
];

type Props = {
  user: { name: string; email: string };
  org: { id: string; name: string };
  role: string;
  memberships: { orgId: string; orgName: string; role: string }[];
  waiting: number;
  children: React.ReactNode;
};

function NavList({ waiting, onNavigate }: { waiting: number; onNavigate?: () => void }) {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="grid gap-0.5">
      {NAV.map((n) => {
        const active = n.href === "/" ? path === "/" : path.startsWith(n.href);
        return (
          <Link
            key={n.href}
            href={n.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex h-9 items-center gap-2.5 rounded-md px-2.5 text-[14.5px] text-ink-2 hover:bg-sunken hover:text-ink",
              active && "bg-sunken font-medium text-ink",
            )}
          >
            <n.icon className={cn("size-[17px]", active ? "text-accent" : "text-ink-3")} strokeWidth={1.8} />
            <span className="flex-1">{n.label}</span>
            {n.badge && waiting > 0 ? (
              <span className="min-w-5 rounded-full bg-wait-soft px-1.5 text-center text-xs leading-5 font-semibold text-wait" aria-label={`${waiting} waiting`}>
                {waiting}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

function OrgSwitcher({ org, role, memberships }: Pick<Props, "org" | "role" | "memberships">) {
  const router = useRouter();
  const single = memberships.length < 2;
  const label = (
    <span className="min-w-0 flex-1 text-left">
      <span className="block truncate text-[14px] font-medium">{org.name}</span>
      <span className="block text-xs text-ink-3 capitalize">{role}</span>
    </span>
  );
  if (single) return <div className="flex items-center gap-2 px-2.5 py-1.5">{label}</div>;
  return (
    <DM.Root>
      <DM.Trigger className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 hover:bg-sunken" aria-label="Switch client">
        {label}
        <ChevronsUpDown className="size-4 text-ink-3" />
      </DM.Trigger>
      <DM.Portal>
        <DM.Content align="start" sideOffset={6} className="z-50 min-w-60 rounded-lg border border-line bg-surface p-1 shadow-lg">
          <DM.Label className="px-2 py-1.5 text-xs text-ink-3">Switch client</DM.Label>
          {memberships.map((m) => (
            <DM.Item
              key={m.orgId}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-sunken"
              onSelect={async () => {
                await api("/api/orgs", { orgId: m.orgId }, "PUT");
                router.push("/");
                router.refresh();
              }}
            >
              <span className="flex-1">
                {m.orgName}
                <span className="ml-2 text-xs text-ink-3 capitalize">{m.role}</span>
              </span>
              {m.orgId === org.id ? <Check className="size-4 text-accent" /> : null}
            </DM.Item>
          ))}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

type Theme = "light" | "dark" | "system";

function applyTheme(t: Theme) {
  document.cookie = `theme=${t}; path=/; max-age=31536000; samesite=lax`;
  const el = document.documentElement;
  el.classList.remove("light", "dark");
  if (t !== "system") el.classList.add(t);
}

function UserMenu({ user }: Pick<Props, "user">) {
  const router = useRouter();
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    const m = /(?:^|;\s*)theme=(light|dark|system)/.exec(document.cookie);
    if (m) setTheme(m[1] as Theme);
  }, []);
  const initials = user.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  return (
    <DM.Root>
      <DM.Trigger className="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 hover:bg-sunken" aria-label="Account">
        <span className="flex size-7 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{initials}</span>
        <span className="min-w-0 flex-1 text-left">
          <span className="block truncate text-[13.5px] font-medium">{user.name}</span>
          <span className="block truncate text-xs text-ink-3">{user.email}</span>
        </span>
      </DM.Trigger>
      <DM.Portal>
        <DM.Content side="top" align="start" sideOffset={6} className="z-50 min-w-56 rounded-lg border border-line bg-surface p-1 shadow-lg">
          <DM.Label className="px-2 py-1.5 text-xs text-ink-3">Appearance</DM.Label>
          {(
            [
              ["light", "Light", Sun],
              ["dark", "Dark", Moon],
              ["system", "Match my device", Monitor],
            ] as const
          ).map(([t, label, Icon]) => (
            <DM.Item
              key={t}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-sunken"
              onSelect={(e) => {
                e.preventDefault();
                setTheme(t);
                applyTheme(t);
              }}
            >
              <Icon className="size-4 text-ink-3" />
              <span className="flex-1">{label}</span>
              {theme === t ? <Check className="size-4 text-accent" /> : null}
            </DM.Item>
          ))}
          <DM.Separator className="my-1 h-px bg-line" />
          <DM.Item
            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-sunken"
            onSelect={async () => {
              await api("/api/auth/session", undefined, "DELETE").catch(() => undefined);
              router.replace("/login");
              router.refresh();
            }}
          >
            <LogOut className="size-4 text-ink-3" />
            Sign out
          </DM.Item>
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

function Sidebar(props: Props & { onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col gap-4 p-3">
      <Link href="/" className="flex items-center gap-2 px-2.5 pt-1.5 pb-1 text-[17px] font-semibold tracking-tight" onClick={props.onNavigate}>
        <Logo />
        Gate
      </Link>
      <OrgSwitcher org={props.org} role={props.role} memberships={props.memberships} />
      <NavList waiting={props.waiting} onNavigate={props.onNavigate} />
      <div className="mt-auto">
        <UserMenu user={props.user} />
      </div>
    </div>
  );
}

export function Shell(props: Props) {
  const [open, setOpen] = useState(false);
  const path = usePathname();
  useEffect(() => setOpen(false), [path]);
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[240px_1fr]">
      <aside className="sticky top-0 hidden h-dvh border-r border-line bg-paper lg:block">
        <Sidebar {...props} />
      </aside>
      <div className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-paper/95 px-4 backdrop-blur lg:hidden">
        <D.Root open={open} onOpenChange={setOpen}>
          <D.Trigger className="-ml-1.5 rounded-md p-1.5 hover:bg-sunken" aria-label="Open menu">
            <Menu className="size-5" />
          </D.Trigger>
          <D.Portal>
            <D.Overlay className="fixed inset-0 z-40 bg-black/40" />
            <D.Content className="fixed inset-y-0 left-0 z-50 w-[280px] border-r border-line bg-paper shadow-xl" aria-describedby={undefined}>
              <D.Title className="sr-only">Menu</D.Title>
              <Sidebar {...props} onNavigate={() => setOpen(false)} />
            </D.Content>
          </D.Portal>
        </D.Root>
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <Logo className="size-5" />
          Gate
        </Link>
        {props.waiting > 0 ? (
          <Link href="/approvals" className="ml-auto rounded-full bg-wait-soft px-2.5 py-0.5 text-[13px] font-semibold text-wait">
            {props.waiting} waiting
          </Link>
        ) : null}
      </div>
      <main className="min-w-0 px-4 py-7 sm:px-8 lg:px-12 lg:py-10">
        <div className="mx-auto max-w-[1080px]">{props.children}</div>
      </main>
    </div>
  );
}
