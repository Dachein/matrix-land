import type { ReactNode } from "react";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/noto-serif-sc";
import "@fontsource/chakra-petch/400.css";
import "./tokens.css";
import "./components.css";
import "./motion.css";

/** Opt in per migrated surface; legacy pages are not visually restyled implicitly. */
export function DesignSystemScope({ children, density = "comfortable", className = "" }: {
  children: ReactNode; density?: "comfortable" | "compact"; className?: string;
}) {
  return <div className={`fw-scope ${className}`} data-density={density}>{children}</div>;
}
