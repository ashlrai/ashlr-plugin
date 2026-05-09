import * as React from "react";
import { cn } from "@/lib/utils";

const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "ledger-card relative",
        className
      )}
      {...props}
    />
  )
);
Card.displayName = "Card";

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("flex flex-col space-y-1.5 p-6", className)}
      {...props}
    />
  )
);
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3
      ref={ref}
      className={cn(
        "font-mono text-[11px] tracking-[0.18em] uppercase text-[var(--ink-55)]",
        className
      )}
      {...props}
    />
  )
);
CardTitle.displayName = "CardTitle";

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
  )
);
CardContent.displayName = "CardContent";

export { Card, CardHeader, CardTitle, CardContent };

// ---------------------------------------------------------------------------
// DashCard — convenience wrapper: <DashCard title="...">children</DashCard>
// Use this in dashboard pages instead of composing Card+CardHeader+CardContent
// manually. Stages 1 + 2 should import this alongside the compound primitives.
// ---------------------------------------------------------------------------

export interface DashCardProps {
  title?: string;
  className?: string;
  children?: React.ReactNode;
}

export function DashCard({ title, className, children }: DashCardProps) {
  return (
    <Card className={cn("flex flex-col gap-0", className)}>
      {title && (
        <CardHeader className="pb-3">
          <CardTitle>{title}</CardTitle>
        </CardHeader>
      )}
      <CardContent className={title ? undefined : "p-6"}>
        {children}
      </CardContent>
    </Card>
  );
}
