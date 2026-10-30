import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const artifactPath = resolve("dist/index.html");
const html = await readFile(artifactPath, "utf8").catch(() => "");
const artifactStat = await stat(artifactPath).catch(() => undefined);
const artifactFiles = artifactStat ? await filesBelow(resolve("dist")) : [];
const javascriptPayload = (await Promise.all(
  artifactFiles
    .filter((file) => file.endsWith(".js"))
    .map((file) => readFile(file, "utf8"))
)).join("\n");
const customNotFoundArtifact = await stat(resolve("dist/404.html")).catch(() => undefined);

const checks = [
  [html.includes("<title>Frontier Workspace</title>"), "missing neutral platform title"],
  [html.includes('<html lang="zh-CN">'), "missing canonical locale marker"],
  [html.includes("vendor-react-"), "missing Portal React chunk"],
  [html.includes("vendor-icons-"), "missing Portal icon chunk"],
  [javascriptPayload.includes("mate-preview-host"), "missing Mate Preview Host lazy chunk"],
  [!customNotFoundArtifact, "top-level 404.html disables Cloudflare Pages SPA fallback"],
  [!html.includes("<title>Frontier Workspace Portal</title>"), "legacy Portal artifact detected"]
];

const failures = checks.filter(([passed]) => !passed).map(([, message]) => message);
if (artifactStat) {
  const sourceFiles = [
    ...(await filesBelow(resolve("apps/portal/src"))),
    ...(await filesBelow(resolve("apps/mate-preview/src"))),
    ...(await filesBelow(resolve("packages/mate-sdk/src"))),
    ...(await filesBelow(resolve("sdk/mate"))).filter((file) => !file.includes("/dist/")),
    ...(await filesBelow(resolve("src/portal"))),
    ...(await filesBelow(resolve("src/shared"))),
    resolve("apps/portal/index.html"),
    resolve("vite.config.ts")
  ];
  const sourceStats = await Promise.all(sourceFiles.filter(file => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)).map(async (file) => ({
    file,
    modifiedAt: (await stat(file)).mtimeMs
  })));
  const newerSource = sourceStats.find((source) => source.modifiedAt > artifactStat.mtimeMs);
  if (newerSource) {
    failures.push(`artifact is older than ${newerSource.file}`);
  }
}

if (failures.length > 0) {
  throw new Error(`Portal artifact verification failed: ${failures.join(", ")}`);
}

console.log(`Portal artifact verified: ${artifactPath}`);

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  }));
  return nested.flat();
}
