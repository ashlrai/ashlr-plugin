import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center border font-mono text-[10px] tracking-[0.16em] uppercase px-2 py-0.5 transition-colors",
  {
    variants: {
      variant: {
        default: "border-[var(--ink-30)] text-[var(--ink-55)]",
        debit: "border-[var(--debit)] text-[var(--debit)] bg-transparent",
        credit: "border-[var(--credit)] text-[var(--credit)] bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
