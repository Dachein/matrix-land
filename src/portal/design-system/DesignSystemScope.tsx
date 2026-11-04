import type { ReactNode } from "react";
import "./styles";

/** Opt in per migrated surface; legacy pages are not visually restyled implicitly. */
export function DesignSystemScope({ children, density = "comfortable", className = "" }: {
  children: ReactNode; density?: "comfortable" | "compact"; className?: string;
}) {
  return <div className={`fw-scope ${className}`} data-density={density}>{children}</div>;
}
