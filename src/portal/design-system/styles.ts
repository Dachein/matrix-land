import "@fontsource-variable/inter";
import "@fontsource/chakra-petch/400.css";
import "./tokens.css";
import "./components.css";
import "./motion.css";
import "./patterns.css";

// CJK font-face tables are large. Paint with the system CJK font first and keep
// the self-hosted typeface out of the render-blocking stylesheet.
if (typeof window !== "undefined") {
  const loadCjkFont = () => { void import("@fontsource-variable/noto-sans-sc").catch(() => undefined); };
  if ("requestIdleCallback" in window) window.requestIdleCallback(loadCjkFont, { timeout: 1500 });
  else setTimeout(loadCjkFont, 0);
}
