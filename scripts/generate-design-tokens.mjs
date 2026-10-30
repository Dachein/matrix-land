import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderDesignTokensCss } from "../src/portal/design-system/tokens.ts";
const file = fileURLToPath(new URL("../src/portal/design-system/tokens.css", import.meta.url));
const output = renderDesignTokensCss();
if (process.argv.includes("--check")) {
  if (readFileSync(file, "utf8") !== output) {
    console.error("Design tokens are out of date. Run npm run design:tokens.");
    process.exitCode = 1;
  } else console.log("Design token CSS matches its source.");
} else { writeFileSync(file, output); console.log("Generated design token CSS."); }
