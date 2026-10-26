import * as React from "react";
import { cn } from "@/lib/utils";

const control =
  "w-full rounded-md border border-line-2 bg-surface px-3 text-[15px] text-ink placeholder:text-ink-3 transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft disabled:opacity-60 aria-[invalid=true]:border-no";

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(control, "h-10", className)} {...props} />;
}

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(control, "min-h-20 py-2 leading-relaxed", className)} {...props} />;
}

export function Select({ className, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(control, "h-10 appearance-none bg-[length:16px] bg-[right_10px_center] bg-no-repeat pr-9", className)} style={{ backgroundImage: "var(--chevron)" }} {...props}>
      {children}
    </select>
  );
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-sm font-medium text-ink", className)} {...props} />;
}

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: React.ReactNode; error?: string | null; children: React.ReactNode; htmlFor?: string }) {
  return (
    <div className="grid content-start gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? (
        <p className="text-[13px] text-no" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[13px] text-ink-3">{hint}</p>
      ) : null}
    </div>
  );
}
