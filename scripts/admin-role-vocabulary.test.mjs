import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { it } from "node:test";

const retiredRole = ["portal", "admin"].join("_");
const sourceFiles = globSync(
  [
    "apps/**/*.{js,mjs,ts,tsx}",
    "functions/**/*.{js,mjs,ts,tsx}",
    "sdk/**/*.{js,mjs,ts,tsx}",
    "src/**/*.{js,mjs,ts,tsx}",
    "workers/**/*.{js,mjs,ts,tsx}"
  ],
  {
    exclude: [
      "**/.wrangler/**",
      "**/dist/**",
      "**/node_modules/**"
    ]
  }
);

it("uses admin as the only Platform Admin runtime identifier", () => {
  const violations = sourceFiles.flatMap((file) => {
    const lines = readFileSync(file, "utf8").split("\n");
    return lines.flatMap((line, index) =>
      line.includes(retiredRole) ? [`${file}:${index + 1}`] : []
    );
  });

  assert.deepEqual(violations, []);
});
