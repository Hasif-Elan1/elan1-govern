import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 cursor-pointer",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-ink hover:opacity-90",
        secondary: "border border-line-2 bg-surface text-ink hover:bg-sunken",
        ghost: "text-ink-2 hover:bg-sunken hover:text-ink",
        approve: "bg-ok text-on-solid hover:opacity-90",
        reject: "border border-no-line bg-no-soft text-no hover:border-no",
        danger: "bg-no text-on-solid hover:opacity-90",
        link: "text-accent underline-offset-4 hover:underline px-0",
      },
      size: {
        sm: "h-8 px-3 text-[13px]",
        md: "h-9 px-4 text-sm",
        lg: "h-12 px-6 text-base",
        icon: "size-9",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { buttonVariants };
