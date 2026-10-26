import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const IST = "Asia/Kolkata";

export function fmtTime(d: Date | string) {
  return new Date(d).toLocaleTimeString("en-IN", { timeZone: IST, hour: "numeric", minute: "2-digit" });
}

export function fmtDate(d: Date | string) {
  return new Date(d).toLocaleDateString("en-IN", { timeZone: IST, day: "numeric", month: "short", year: "numeric" });
}

export function fmtDateTime(d: Date | string) {
  return new Date(d).toLocaleString("en-IN", { timeZone: IST, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

/** "Today", "Yesterday" or a date, in India time. */
export function dayLabel(d: Date | string) {
  const key = (x: Date) => x.toLocaleDateString("en-CA", { timeZone: IST });
  const date = new Date(d);
  const today = new Date();
  if (key(date) === key(today)) return "Today";
  if (key(date) === key(new Date(today.getTime() - 86_400_000))) return "Yesterday";
  return date.toLocaleDateString("en-IN", { timeZone: IST, weekday: "long", day: "numeric", month: "long" });
}

export function istDay(d = new Date()) {
  return d.toLocaleDateString("en-CA", { timeZone: IST });
}

export function relative(d: Date | string | null | undefined) {
  if (!d) return "Never";
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 45) return "Just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return fmtDate(d);
}

export function timeLeft(to: Date | string) {
  const ms = new Date(to).getTime() - Date.now();
  if (ms <= 0) return "Expired";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} min left`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min left`;
  return `${Math.floor(h / 24)} days left`;
}

export const shortHash = (h: string) => h.replace(/^sha256:/, "").slice(0, 12);
