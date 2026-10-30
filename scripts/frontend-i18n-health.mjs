import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const appDirs = [
  path.join(rootDir, "src", "portal"),
  path.join(rootDir, "apps", "portal", "src")
];
const sourceDirs = [
  path.join(rootDir, "src"),
  path.join(rootDir, "apps", "portal", "src")
];
const resourcePaths = {
  en: path.join("src", "portal", "i18n", "resources.en.ts"),
  metadata: path.join("src", "portal", "i18n", "resources.ts"),
  ownershipEn: path.join("src", "portal", "i18n", "resources.ownership.en.ts"),
  ownershipZhCN: path.join("src", "portal", "i18n", "resources.ownership.zh-CN.ts"),
  zhCN: path.join("src", "portal", "i18n", "resources.zh-CN.ts")
};
const resourcePathSet = new Set(Object.values(resourcePaths));
const classificationPath = path.join("scripts", "frontend-i18n-classifications.json");
const jsonOutput = process.argv.includes("--json");

const sourceFiles = appDirs.flatMap(listFiles)
  .filter((filePath) => /\.(ts|tsx)$/.test(filePath))
  .map((filePath) => ({
    absolutePath: filePath,
    relativePath: path.relative(rootDir, filePath),
    source: readFileSync(filePath, "utf8")
  }))
  .filter((file) => !resourcePathSet.has(file.relativePath))
  .filter((file) => !file.relativePath.includes(".test."));
const referenceSourceFiles = sourceDirs.flatMap(listFiles)
  .filter((filePath) => /\.(ts|tsx)$/.test(filePath))
  .map((filePath) => ({
    absolutePath: filePath,
    relativePath: path.relative(rootDir, filePath),
    source: readFileSync(filePath, "utf8")
  }))
  .filter((file) => !resourcePathSet.has(file.relativePath))
  .filter((file) => !file.relativePath.includes(".test."));

const zhResources = [resourcePaths.zhCN, resourcePaths.ownershipZhCN].flatMap(file => parseResourceSource(readFileSync(path.join(rootDir, file), "utf8")));
const enResources = [resourcePaths.en, resourcePaths.ownershipEn].flatMap(file => parseResourceSource(readFileSync(path.join(rootDir, file), "utf8")));
const duplicateZhKeys = duplicateKeys(zhResources);
const duplicateEnKeys = duplicateKeys(enResources);
const zhKeys = new Set(zhResources.map((entry) => entry.key));
const enKeys = new Set(enResources.map((entry) => entry.key));
const missingEnglishKeys = [...zhKeys].filter((key) => !enKeys.has(key)).sort();
const extraEnglishKeys = [...enKeys].filter((key) => !zhKeys.has(key)).sort();
const placeholderParityIssues = placeholderMismatches(zhResources, enResources);
const referenceSourceIndex = referenceSourceFiles.map((file) => file.source).join("\n");
const unusedKeys = [...zhKeys]
  .filter((key) => !referenceSourceIndex.includes(`"${key}"`) && !referenceSourceIndex.includes(`'${key}'`))
  .sort();
const unusedKeyClassifications = loadUnusedKeyClassifications();
const unusedKeyDetails = classifyUnusedKeys(unusedKeys, unusedKeyClassifications);
const classifiedUnusedKeys = unusedKeyDetails.filter((item) => item.classification);
const unclassifiedUnusedKeys = unusedKeyDetails.filter((item) => !item.classification);
const unclassifiedUnusedKeyList = unclassifiedUnusedKeys.map((item) => item.key);
const unusedKeysByPrefix = countByPrefix(unusedKeys);
const unclassifiedUnusedKeysByPrefix = countByPrefix(unclassifiedUnusedKeyList);
const unusedKeysByBucket = countByBucket(classifiedUnusedKeys);
const staleUnusedKeyClassifications = unusedKeyClassifications
  .filter((classification) => !unusedKeys.some((key) => matchesClassification(key, classification)))
  .map(({ bucket, key, pattern, reason }) => ({ bucket, key, pattern, reason }));
const repeatedZhValues = repeatedValues(zhResources);
const repeatedEnValues = repeatedValues(enResources);

const fileReports = sourceFiles
  .map((file) => {
    const lines = file.source.split(/\r?\n/);
    const cjkLines = lines.filter((line) => /\p{Script=Han}/u.test(line) && !line.includes("i18n-allow-cjk"));
    const englishUiLines = lines.flatMap((line, index) => {
      const candidates = englishUiHardcodedCandidates(line);
      return candidates.length > 0 ? [{ candidates, line: index + 1 }] : [];
    });
    const inlineLocaleBranches =
      countMatches(file.source, /locale\s*={0,2}\s*["']zh-CN["']/g) +
      countMatches(file.source, /\bisZh\b/g) +
      countMatches(file.source, /\bisEnglish\b/g) +
      countMatches(file.source, /\blabelZh\b/g) +
      countMatches(file.source, /\bdetailZh\b/g) +
      countMatches(file.source, /\bzh\s*:/g);

    return {
      cjkLineCount: cjkLines.length,
      englishUiLineCount: englishUiLines.length,
      englishUiLines,
      inlineLocaleBranches,
      path: file.relativePath
    };
  })
  .filter((file) => file.cjkLineCount > 0 || file.englishUiLineCount > 0 || file.inlineLocaleBranches > 0);

const metrics = {
  cjkLineCount: sum(fileReports, (file) => file.cjkLineCount),
  englishUiHardcodedLines: sum(fileReports, (file) => file.englishUiLineCount),
  filesWithCjk: fileReports.filter((file) => file.cjkLineCount > 0).length,
  filesWithEnglishUiHardcoded: fileReports.filter((file) => file.englishUiLineCount > 0).length,
  filesWithInlineLocaleBranches: fileReports.filter((file) => file.inlineLocaleBranches > 0).length,
  inlineLocaleBranches: sum(fileReports, (file) => file.inlineLocaleBranches),
  duplicateKeys: duplicateZhKeys.length + duplicateEnKeys.length,
  localeParityIssues: missingEnglishKeys.length + extraEnglishKeys.length,
  placeholderParityIssues: placeholderParityIssues.length,
  resourceEntries: zhResources.length + enResources.length,
  classifiedUnusedKeys: classifiedUnusedKeys.length,
  translationKeys: zhResources.length,
  unclassifiedUnusedKeys: unclassifiedUnusedKeys.length,
  unusedKeys: unusedKeys.length
};

const topCjkFiles = topFiles(fileReports, "cjkLineCount");
const topEnglishUiFiles = topFiles(fileReports, "englishUiLineCount");
const topInlineLocaleFiles = topFiles(fileReports, "inlineLocaleBranches");

const report = {
  metrics,
  repeatedEnValues: repeatedEnValues.slice(0, 10),
  repeatedZhValues: repeatedZhValues.slice(0, 10),
  staleUnusedKeyClassifications,
  topCjkFiles,
  topEnglishUiFiles,
  topInlineLocaleFiles,
  topUnusedPrefixes: unusedKeysByPrefix.slice(0, 10),
  topUnclassifiedUnusedPrefixes: unclassifiedUnusedKeysByPrefix.slice(0, 10),
  unusedKeys,
  unusedKeyClassifications: classifiedUnusedKeys,
  unusedKeysByBucket,
  unclassifiedUnusedKeys: unclassifiedUnusedKeyList,
  missingEnglishKeys,
  extraEnglishKeys,
  duplicateZhKeys,
  duplicateEnKeys,
  placeholderParityIssues: placeholderParityIssues.slice(0, 50)
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

function englishUiHardcodedCandidates(line) {
  if (line.includes("i18n-allow-en")) {
    return [];
  }

  const candidates = [];
  const textPattern = />\s*([^<>{}]*[A-Za-z][^<>{}]*)\s*<\/[A-Za-z][\w.:-]*>/g;
  const attributePattern = /\b(aria-label|title|placeholder|eyebrow|label)=['"]([^'"]*[A-Za-z][^'"]*)['"]/g;
  let match;

  while ((match = textPattern.exec(line))) {
    if (!isAllowedEnglishUiLiteral(line, match[1])) {
      candidates.push({
        kind: "text",
        value: match[1].trim()
      });
    }
  }

  while ((match = attributePattern.exec(line))) {
    if (!isAllowedEnglishUiLiteral(line, match[2])) {
      candidates.push({
        kind: match[1],
        value: match[2].trim()
      });
    }
  }

  return candidates;
}

function isAllowedEnglishUiLiteral(line, value) {
  const normalized = value.trim();

  if (!normalized || !/[A-Za-z]/.test(normalized)) {
    return true;
  }

  if (/<\/?(code|pre)\b/.test(line)) {
    return true;
  }

  if (/^(GET|POST|PUT|PATCH|DELETE)\s+\//.test(normalized)) {
    return true;
  }

  return /^[A-Z0-9_./:-]+$/.test(normalized) && normalized.length <= 16;
}

function parseResourceSource(source) {
  const entries = [];
  const pattern = /^\s+"([^"]+)":\s+"((?:\\.|[^"])*)",?$/gm;
  let match;

  while ((match = pattern.exec(source))) {
    entries.push({
      key: match[1],
      value: match[2]
    });
  }

  return entries;
}

function countByPrefix(keys) {
  const counts = new Map();

  for (const key of keys) {
    const prefix = key.split(".")[0] ?? key;
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([prefix, count]) => ({ count, prefix }));
}

function countByBucket(items) {
  const counts = new Map();

  for (const item of items) {
    const bucket = item.classification.bucket;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([bucket, count]) => ({ bucket, count }));
}

function duplicateKeys(entries) {
  const counts = new Map();

  for (const entry of entries) {
    counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([key, count]) => ({ count, key }));
}

function loadUnusedKeyClassifications() {
  const absoluteClassificationPath = path.join(rootDir, classificationPath);

  if (!existsSync(absoluteClassificationPath)) {
    return [];
  }

  const payload = JSON.parse(readFileSync(absoluteClassificationPath, "utf8"));
  const entries = Array.isArray(payload.classifications) ? payload.classifications : [];

  return entries.flatMap((entry, index) => normalizeClassification(entry, index));
}

function normalizeClassification(entry, index) {
  const bucket = readClassificationString(entry.bucket, `classifications[${index}].bucket`);
  const reason = readClassificationString(entry.reason, `classifications[${index}].reason`);
  const keys = Array.isArray(entry.keys) ? entry.keys : [];
  const normalized = [];

  if (entry.key) {
    normalized.push({
      bucket,
      key: readClassificationString(entry.key, `classifications[${index}].key`),
      reason
    });
  }

  if (entry.pattern) {
    normalized.push({
      bucket,
      pattern: readClassificationString(entry.pattern, `classifications[${index}].pattern`),
      reason
    });
  }

  keys.forEach((key, keyIndex) => {
    normalized.push({
      bucket,
      key: readClassificationString(key, `classifications[${index}].keys[${keyIndex}]`),
      reason
    });
  });

  if (normalized.length === 0) {
    throw new Error(`Missing key, keys, or pattern in ${classificationPath} classifications[${index}]`);
  }

  return normalized;
}

function readClassificationString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Expected ${label} in ${classificationPath} to be a non-empty string`);
  }

  return value.trim();
}

function classifyUnusedKeys(keys, classifications) {
  return keys.map((key) => ({
    classification: classifications.find((classification) => matchesClassification(key, classification)),
    key
  }));
}

function matchesClassification(key, classification) {
  if (classification.key) {
    return classification.key === key;
  }

  return globToRegExp(classification.pattern).test(key);
}

function globToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*");

  return new RegExp(`^${escaped}$`);
}

function placeholderMismatches(zhEntries, enEntries) {
  const zhByKey = new Map(zhEntries.map((entry) => [entry.key, entry.value]));
  const enByKey = new Map(enEntries.map((entry) => [entry.key, entry.value]));
  const issues = [];

  for (const [key, zhValue] of zhByKey) {
    if (!enByKey.has(key)) {
      continue;
    }

    const zhPlaceholders = placeholders(zhValue).join(",");
    const enPlaceholders = placeholders(enByKey.get(key)).join(",");

    if (zhPlaceholders !== enPlaceholders) {
      issues.push({
        enPlaceholders,
        key,
        zhPlaceholders
      });
    }
  }

  return issues;
}

function placeholders(value) {
  return [...value.matchAll(/\{(\w+)\}/g)]
    .map((match) => match[1])
    .sort();
}

function repeatedValues(entries) {
  const values = new Map();

  for (const entry of entries) {
    const normalized = entry.value.replace(/\{\w+\}/g, "{}").trim();

    if (normalized.length < 4) {
      continue;
    }

    if (!values.has(normalized)) {
      values.set(normalized, []);
    }

    values.get(normalized).push(entry.key);
  }

  return [...values.entries()]
    .filter(([, keys]) => keys.length > 1)
    .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
    .map(([value, keys]) => ({
      count: keys.length,
      keys,
      value
    }));
}

function sum(items, readValue) {
  return items.reduce((total, item) => total + readValue(item), 0);
}

function topFiles(files, key) {
  return files
    .filter((file) => file[key] > 0)
    .sort((left, right) => right[key] - left[key] || left.path.localeCompare(right.path))
    .slice(0, 10)
    .map((file) => ({
      count: file[key],
      path: file.path
    }));
}

function printReport(data) {
  console.log("Frontend i18n Health");
  console.log("====================");
  console.log(`Translation keys: ${data.metrics.translationKeys} (${data.metrics.resourceEntries} locale entries)`);
  console.log(`Locale parity issues: ${data.metrics.localeParityIssues}`);
  console.log(`Placeholder parity issues: ${data.metrics.placeholderParityIssues}`);
  console.log(`Duplicate key issues: ${data.metrics.duplicateKeys}`);
  console.log(`Potentially unused keys: ${data.metrics.unusedKeys}`);
  console.log(`Classified unused keys: ${data.metrics.classifiedUnusedKeys}`);
  console.log(`Unclassified unused keys: ${data.metrics.unclassifiedUnusedKeys}`);
  console.log(`CJK hardcoded lines outside resources: ${data.metrics.cjkLineCount} across ${data.metrics.filesWithCjk} files`);
  console.log(`English UI hardcoded candidate lines: ${data.metrics.englishUiHardcodedLines} across ${data.metrics.filesWithEnglishUiHardcoded} files`);
  console.log(`Inline locale branch signals: ${data.metrics.inlineLocaleBranches} across ${data.metrics.filesWithInlineLocaleBranches} files`);
  console.log("");
  printTopPrefixes("Top potentially unused key prefixes", data.topUnusedPrefixes);
  printTopPrefixes("Top unclassified unused key prefixes", data.topUnclassifiedUnusedPrefixes);
  printTopBuckets("Unused key classification buckets", data.unusedKeysByBucket);
  console.log("");
  printTopFiles("Top CJK hardcoded files", data.topCjkFiles);
  printTopFiles("Top English UI hardcoded files", data.topEnglishUiFiles);
  printTopFiles("Top inline locale branch files", data.topInlineLocaleFiles);
  printRepeatedValues("Repeated zh-CN values", data.repeatedZhValues);
  printRepeatedValues("Repeated en values", data.repeatedEnValues);
  console.log("");
  console.log("Interpretation:");
  console.log("- Locale parity issues are hard failures once this check becomes a CI gate.");
  console.log("- Potentially unused keys are advisory: dynamic usage and planned slices can produce false positives.");
  console.log("- Classified unused keys are intentionally tracked in scripts/frontend-i18n-classifications.json; unclassified keys need triage.");
  console.log("- CJK lines outside i18n resources usually indicate user-facing copy that should move into resources.");
  console.log("- English UI candidates cover JSX text and common UI string attributes; technical code/pre literals and short protocol tokens are ignored.");
  console.log("- Inline locale branches are allowed temporarily, but repeated branches should become resource keys or domain label helpers.");
  console.log("- Repeated values are not always wrong, but they are a good prompt to check whether labels should share a helper or remain context-specific.");
}

function printTopFiles(title, files) {
  console.log(title);

  if (files.length === 0) {
    console.log("  none");
    return;
  }

  for (const file of files) {
    console.log(`  ${String(file.count).padStart(3, " ")}  ${file.path}`);
  }
}

function printTopPrefixes(title, prefixes) {
  console.log(title);

  if (prefixes.length === 0) {
    console.log("  none");
    return;
  }

  for (const item of prefixes) {
    console.log(`  ${String(item.count).padStart(3, " ")}  ${item.prefix}`);
  }
}

function printTopBuckets(title, buckets) {
  console.log(title);

  if (buckets.length === 0) {
    console.log("  none");
    return;
  }

  for (const item of buckets) {
    console.log(`  ${String(item.count).padStart(3, " ")}  ${item.bucket}`);
  }
}

function printRepeatedValues(title, values) {
  console.log(title);

  if (values.length === 0) {
    console.log("  none");
    return;
  }

  for (const item of values.slice(0, 5)) {
    console.log(`  ${String(item.count).padStart(3, " ")}  ${item.value} -> ${item.keys.slice(0, 5).join(", ")}`);
  }
}
