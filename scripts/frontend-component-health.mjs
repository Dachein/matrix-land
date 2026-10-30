import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const appDirs = [
  path.join(rootDir, "src", "portal"),
  path.join(rootDir, "apps", "portal", "src")
];
const jsonOutput = process.argv.includes("--json");
const largeFileThreshold = 700;

const primitiveFiles = new Set([
  path.join("src", "portal", "components", "Button.tsx"),
  path.join("src", "portal", "components", "FormField.tsx"),
  path.join("src", "portal", "components", "ModalShell.tsx"),
  path.join("src", "portal", "components", "SegmentedControl.tsx")
]);

const legacyActionPattern = /\b(primaryButton|secondaryButton|dangerButton|iconButton|iconOnlyButton|primaryAction|secondaryAction|iconTextButton)\b/g;
const legacyFieldClassPattern = /\bclassName=["'][^"']*\b(?:formField|fieldControl)\b[^"']*["']/g;

const files = appDirs.flatMap(listFiles)
  .filter((filePath) => filePath.endsWith(".tsx"))
  .map((filePath) => ({
    absolutePath: filePath,
    relativePath: path.relative(rootDir, filePath),
    source: readFileSync(filePath, "utf8")
  }));

const surfaceFiles = files.filter((file) => !primitiveFiles.has(file.relativePath));
for (const file of files) {
  file.lineCount = countLines(file.source);
}

const metrics = {
  primitiveButtons: sum(surfaceFiles, (file) => countMatches(file.source, /<Button(?:\s|>|\/)/g) + countMatches(file.source, /<ButtonLink(?:\s|>|\/)/g)),
  primitiveButtonOverrides: sum(surfaceFiles, (file) => countMatches(file.source, /<Button(?:Link)?\b[^>]*\bclassName=/gs)),
  nativeButtons: sum(surfaceFiles, (file) => countMatches(file.source, /<button\b/g)),
  legacyActionClassRefs: sum(surfaceFiles, (file) => countMatches(file.source, legacyActionPattern)),
  modalShellUsages: sum(surfaceFiles, (file) => countMatches(file.source, /<ModalShell(?:\s|>|\/)/g)),
  legacyDialogRoles: sum(surfaceFiles, (file) => countMatches(file.source, /role=["']dialog["']/g)),
  segmentedControlUsages: sum(surfaceFiles, (file) => countMatches(file.source, /<SegmentedControl(?:[\s<>/])/g)),
  legacySegmentedContainers: sum(surfaceFiles, (file) => countMatches(file.source, /\bsegmentedControl\b/g)),
  formFieldUsages: sum(surfaceFiles, (file) => countMatches(file.source, /<FormField(?:\s|>|\/)/g)),
  legacyFieldClassRefs: sum(surfaceFiles, (file) => countMatches(file.source, legacyFieldClassPattern)),
  largeSurfaceFiles: surfaceFiles.filter((file) => file.lineCount > largeFileThreshold).length,
  largestSurfaceFileLines: Math.max(...surfaceFiles.map((file) => file.lineCount))
};

const actionPrimitiveRate = ratio(metrics.primitiveButtons, metrics.primitiveButtons + metrics.legacyActionClassRefs);
const buttonOverrideRate = ratio(metrics.primitiveButtonOverrides, metrics.primitiveButtons);
const modalShellAdoptionRate = ratio(metrics.modalShellUsages, metrics.modalShellUsages + metrics.legacyDialogRoles);
const segmentedControlAdoptionRate = ratio(metrics.segmentedControlUsages, metrics.segmentedControlUsages + metrics.legacySegmentedContainers);
const formFieldAdoptionRate = ratio(metrics.formFieldUsages, metrics.formFieldUsages + metrics.legacyFieldClassRefs);
const largeFileHealthRate = 1 - Math.min(metrics.largeSurfaceFiles / 5, 1);

const score = Math.round(100 * (
  (actionPrimitiveRate * 0.38) +
  ((1 - buttonOverrideRate) * 0.16) +
  (modalShellAdoptionRate * 0.2) +
  (segmentedControlAdoptionRate * 0.16) +
  (largeFileHealthRate * 0.1)
));

const topLegacyActionFiles = topFiles(surfaceFiles, (source) => countMatches(source, legacyActionPattern));
const topNativeButtonFiles = topFiles(surfaceFiles, (source) => countMatches(source, /<button\b/g));
const topLegacySegmentedFiles = topFiles(surfaceFiles, (source) => countMatches(source, /\bsegmentedControl\b/g));
const topLegacyFieldFiles = topFiles(surfaceFiles, (source) => countMatches(source, legacyFieldClassPattern));
const topLargeFiles = surfaceFiles
  .map((file) => ({
    count: file.lineCount,
    path: file.relativePath
  }))
  .sort((left, right) => right.count - left.count || left.path.localeCompare(right.path))
  .slice(0, 8);

const report = {
  score,
  largeFileThreshold,
  metrics,
  rates: {
    actionPrimitiveRate,
    buttonOverrideRate,
    modalShellAdoptionRate,
    segmentedControlAdoptionRate,
    formFieldAdoptionRate,
    largeFileHealthRate
  },
  topLegacyActionFiles,
  topNativeButtonFiles,
  topLegacySegmentedFiles,
  topLegacyFieldFiles,
  topLargeFiles
};

if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printReport(report);
}

function listFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const filePath = path.join(directory, entry);
    const stats = statSync(filePath);
    return stats.isDirectory() ? listFiles(filePath) : [filePath];
  });
}

function countMatches(source, pattern) {
  return source.match(pattern)?.length ?? 0;
}

function countLines(source) {
  return source.length === 0 ? 0 : source.split("\n").length;
}

function sum(items, readValue) {
  return items.reduce((total, item) => total + readValue(item), 0);
}

function ratio(value, total) {
  return total > 0 ? value / total : 1;
}

function topFiles(sourceFiles, readCount) {
  return sourceFiles
    .map((file) => ({
      count: readCount(file.source),
      path: file.relativePath
    }))
    .filter((file) => file.count > 0)
    .sort((left, right) => right.count - left.count || left.path.localeCompare(right.path))
    .slice(0, 8);
}

function printReport(data) {
  console.log("Frontend Component Health");
  console.log("=========================");
  console.log(`Score: ${data.score}/100`);
  console.log("");
  console.log(`Action primitive adoption: ${formatPercent(data.rates.actionPrimitiveRate)} (${data.metrics.primitiveButtons} Button/ButtonLink usages, ${data.metrics.legacyActionClassRefs} legacy action class refs)`);
  console.log(`Button override rate: ${formatPercent(data.rates.buttonOverrideRate)} (${data.metrics.primitiveButtonOverrides}/${data.metrics.primitiveButtons})`);
  console.log(`ModalShell adoption: ${formatPercent(data.rates.modalShellAdoptionRate)} (${data.metrics.modalShellUsages} ModalShell usages, ${data.metrics.legacyDialogRoles} legacy dialog roles)`);
  console.log(`SegmentedControl adoption: ${formatPercent(data.rates.segmentedControlAdoptionRate)} (${data.metrics.segmentedControlUsages} primitive usages, ${data.metrics.legacySegmentedContainers} legacy segmented containers)`);
  console.log(`FormField adoption watch: ${formatPercent(data.rates.formFieldAdoptionRate)} (${data.metrics.formFieldUsages} FormField usages, ${data.metrics.legacyFieldClassRefs} legacy field class refs)`);
  console.log(`Large file governance: ${data.metrics.largeSurfaceFiles} files over ${data.largeFileThreshold} lines; largest surface file ${data.metrics.largestSurfaceFileLines} lines`);
  console.log(`Native button surface: ${data.metrics.nativeButtons} raw <button> elements`);
  console.log("");
  printTopFiles("Top legacy action class files", data.topLegacyActionFiles);
  printTopFiles("Top native button files", data.topNativeButtonFiles);
  printTopFiles("Top legacy segmented-control files", data.topLegacySegmentedFiles);
  printTopFiles("Top legacy field files", data.topLegacyFieldFiles);
  printTopFiles("Top large surface files", data.topLargeFiles);
  console.log("");
  console.log("Interpretation:");
  console.log("- High legacy action refs usually mean standard actions should move to Button/ButtonLink.");
  console.log("- High Button override rate means the primitive API is probably missing a semantic variant or spacing token.");
  console.log("- Raw <button> is acceptable for compound controls, but repeated active-state groups should become SegmentedControl/ToggleGroup.");
  console.log("- FormField is a new watch metric and is not included in the score yet; migrate it slice by slice.");
  console.log("- Large route/component files should split into domain types, hooks/models, and view components before they cross the threshold.");
}

function printTopFiles(title, filesForSection) {
  console.log(title);

  if (filesForSection.length === 0) {
    console.log("  none");
    return;
  }

  for (const file of filesForSection) {
    console.log(`  ${String(file.count).padStart(3, " ")}  ${file.path}`);
  }
}

function formatPercent(value) {
  return `${Math.round(value * 1000) / 10}%`;
}
