import { readdir, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

const sourceRoots = [
  resolve("apps/portal/src"),
  resolve("src/portal"),
  resolve("tests/e2e")
];
const standaloneFiles = [resolve("scripts/frontend-css-health.mjs")];
const sourceFiles = (await Promise.all(sourceRoots.map(filesBelow))).flat();
const files = [...sourceFiles, ...standaloneFiles].filter((file) => (
  [".css", ".mjs", ".ts", ".tsx"].includes(extname(file))
));
const retiredPrefix = ["v2", "-"].join("");
const violations = [];

for (const file of files) {
  const source = await readFile(file, "utf8");
  if (source.includes(retiredPrefix)) {
    violations.push(file);
  }
}

if (violations.length > 0) {
  throw new Error(`Retired Portal CSS namespace found in: ${violations.join(", ")}`);
}

console.log(`Portal namespace verified across ${files.length} files.`);

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  }));
  return nested.flat();
}
