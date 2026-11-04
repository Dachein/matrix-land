import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderDesignTokensCss } from "../src/portal/design-system/tokens.ts";
import { renderPortalTokensCss } from "../src/portal/design-system/portalTokens.ts";
for (const [path, render] of [
  ["../src/portal/design-system/tokens.css", renderDesignTokensCss],
  ["../apps/portal/src/styles/tokens.css", renderPortalTokensCss]
]) {
  const file = fileURLToPath(new URL(path, import.meta.url));
  const output = render();
  if (process.argv.includes("--check")) {
    if (readFileSync(file, "utf8") !== output) {
      console.error(`${path} is out of date. Run npm run design:tokens.`);
      process.exitCode = 1;
    } else console.log(`${path} matches its source.`);
  } else { writeFileSync(file, output); console.log(`Generated ${path}.`); }
}
