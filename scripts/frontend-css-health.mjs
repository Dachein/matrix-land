import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { analyzeCssSelectorReuse } from "./frontend-css-reuse.mjs";

const rootDir = process.cwd();
const jsonOutput = process.argv.includes("--json");

const cssFiles = readCssEntryFiles();
const source = cssFiles.map((file) => `/* ${file.relativePath} */\n${file.source}`).join("\n\n");
const lineCount = sum(cssFiles, (file) => file.source.split(/\r?\n/).length);
const sourceWithoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
const rootBlocks = readRootBlocks(sourceWithoutComments);
const cssOutsideRoot = removeRootBlocks(sourceWithoutComments, rootBlocks);

const rootTokens = rootBlocks.flatMap((block) => parseRootTokens(block.body));
const rootTokenNames = rootTokens.map((token) => token.name);
const rootTokenNameSet = new Set(rootTokenNames);
const semanticTokenCount = rootTokens.filter((token) => isSemanticToken(token.name)).length;
const aliasTokenNames = [
  "--ink",
  "--muted",
  "--line",
  "--panel",
  "--panel-strong",
  "--blue",
  "--green",
  "--gold",
  "--red",
  "--violet",
  "--acid",
  "--cyan",
  "--radius"
];

const ruleBlocks = parseRuleBlocks(sourceWithoutComments);
const selectors = ruleBlocks.flatMap((block) => block.selectors);
const ownership = countOwnership(selectors);
const selectorReuse = analyzeCssSelectorReuse(cssFiles);
const aliasUsage = aliasTokenNames
  .map((token) => ({
    count: countMatches(cssOutsideRoot, new RegExp(`var\\(\\s*${escapeRegExp(token)}\\s*(?:[,\\)])`, "g")),
    token
  }))
  .filter((item) => item.count > 0)
  .sort((left, right) => right.count - left.count || left.token.localeCompare(right.token));
const rawHexColors = cssOutsideRoot.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
const rawRgbColors = (cssOutsideRoot.match(/\brgba?\(([^)]*)\)/g) ?? []).filter((value) => !value.includes("var("));
const importantUsages = countMatches(cssOutsideRoot, /!important\b/g);
const mediaQueries = countMatches(sourceWithoutComments, /@media\b/g);
const keyframes = countMatches(sourceWithoutComments, /@keyframes\b/g);
const undefinedCustomProperties = collectUndefinedCustomProperties(sourceWithoutComments, rootTokenNameSet);
const suspiciousUndefinedCustomProperties = undefinedCustomProperties.filter((item) => item.kind !== "component-local");
const radiusBaseline = readRadiusBaseline();
const radiusPolicy = inspectRadiusPolicy(cssFiles, rootTokens, radiusBaseline.exceptions);

const metrics = {
  aliasTokenUses: sum(aliasUsage, (item) => item.count),
  cssFiles: cssFiles.length,
  importantUsages,
  keyframes,
  lineCount,
  mediaQueries,
  rawColorLiterals: rawHexColors.length + rawRgbColors.length,
  rawHexColors: rawHexColors.length,
  rawRgbColors: rawRgbColors.length,
  repeatedSelectors: selectorReuse.repeatedSelectorGroups,
  repeatedSelectorOccurrences: selectorReuse.selectorOccurrences,
  repeatedSameContextGroups: selectorReuse.sameContextSelectorGroups,
  responsiveSelectorGroups: selectorReuse.responsiveSelectorGroups.length,
  crossFileSelectorGroups: selectorReuse.crossFileSelectorGroups.length,
  exactDuplicateRuleGroups: selectorReuse.exactDuplicateRuleGroups,
  exactDuplicateRuleCopies: selectorReuse.exactDuplicateRuleCopies,
  ruleBlocks: ruleBlocks.length,
  selectors: selectors.length,
  semanticTokenCount,
  suspiciousUndefinedCustomProperties: suspiciousUndefinedCustomProperties.length,
  legacyLargeRadiusExceptions: radiusPolicy.currentExceptions.length,
  visualGeometryViolations: radiusPolicy.violations.length,
  undefinedCustomProperties: undefinedCustomProperties.length,
  tokenCount: rootTokens.length
};

const report = {
  metrics,
  aliasUsage,
  cssFiles: cssFiles.map((file) => ({
    lines: file.source.split(/\r?\n/).length,
    path: file.relativePath
  })),
  ownership,
  radiusPolicy,
  selectorReuse,
  suspiciousUndefinedCustomProperties,
  topRawHexColors: topValues(rawHexColors, 12).map(([value, count]) => ({ count, value })),
  topRawRgbColors: topValues(rawRgbColors, 8).map(([value, count]) => ({ count, value })),
  tokenPrefixes: countTokenPrefixes(rootTokenNames),
  tokenNames: rootTokenNames,
  undefinedCustomProperties
};

if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printReport(report);
}

if (radiusPolicy.violations.length > 0) {
  process.exitCode = 1;
}

function readRootBlocks(css) {
  const blocks = [];
  let searchFrom = 0;

  while (searchFrom < css.length) {
    const start = css.indexOf(":root", searchFrom);
    if (start === -1) {
      break;
    }

    const open = css.indexOf("{", start);
    if (open === -1) {
      break;
    }

    let depth = 0;
    let end = -1;
    for (let index = open; index < css.length; index += 1) {
      const char = css[index];
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          blocks.push({ body: css.slice(open + 1, index), end, start });
          break;
        }
      }
    }

    if (end === -1) {
      break;
    }
    searchFrom = end;
  }

  return blocks;
}

function removeRootBlocks(css, blocks) {
  return [...blocks]
    .sort((left, right) => right.start - left.start)
    .reduce((result, block) => result.slice(0, block.start) + result.slice(block.end), css);
}

function readCssEntryFiles() {
  const portalStyleDirectory = path.join(rootDir, "apps", "portal", "src", "styles");
  const entries = readdirSync(portalStyleDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".css"))
    .map((entry) => path.join(portalStyleDirectory, entry.name));

  return entries.map(readCssFile);
}

function readCssFile(absolutePath) {
  return {
    absolutePath,
    relativePath: path.relative(rootDir, absolutePath),
    source: readFileSync(absolutePath, "utf8")
  };
}

function readRadiusBaseline() {
  const baselinePath = path.join(rootDir, "scripts", "frontend-css-radius-baseline.json");
  const parsed = JSON.parse(readFileSync(baselinePath, "utf8"));

  if (!Array.isArray(parsed.exceptions) || parsed.exceptions.some((value) => typeof value !== "string")) {
    throw new Error("frontend-css-radius-baseline.json must contain a string exceptions array");
  }

  return parsed;
}

function parseRootTokens(block) {
  return [...block.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)].map((match) => ({
    name: match[1],
    value: match[2].trim()
  }));
}

function parseRuleBlocks(css) {
  const blocks = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;

  while ((match = pattern.exec(css))) {
    const rawSelector = match[1].trim();

    if (!rawSelector || rawSelector.startsWith("@") || isKeyframeStep(rawSelector)) {
      continue;
    }

    blocks.push({
      body: match[2],
      selectors: rawSelector
        .split(",")
        .map((selector) => selector.trim())
        .filter(Boolean),
      source: match[0]
    });
  }

  return blocks;
}

function inspectRadiusPolicy(files, tokens, baselineExceptions) {
  const baseline = new Set(baselineExceptions);
  const currentLargeRadiusDeclarations = [];

  for (const file of files) {
    const css = file.source.replace(/\/\*[\s\S]*?\*\//g, "");

    for (const block of parseRuleBlocks(css)) {
      const declarations = block.body.matchAll(
        /((?:border-(?:top-left-|top-right-|bottom-left-|bottom-right-)?radius))\s*:\s*([^;]+);/g
      );

      for (const declaration of declarations) {
        const property = declaration[1];
        const value = normalizeCssFragment(declaration[2]);

        if (!radiusExceedsControlLimit(value)) {
          continue;
        }

        const selector = block.selectors.join(", ");
        const fingerprint = `${file.relativePath}|${selector}|${property}:${value}`;
        currentLargeRadiusDeclarations.push({ file: file.relativePath, fingerprint, property, selector, value });
      }
    }
  }

  const currentFingerprints = new Set(currentLargeRadiusDeclarations.map((item) => item.fingerprint));
  const currentExceptions = currentLargeRadiusDeclarations.filter((item) => baseline.has(item.fingerprint));
  const staleExceptions = baselineExceptions.filter((fingerprint) => !currentFingerprints.has(fingerprint));
  const violations = currentLargeRadiusDeclarations
    .filter((item) => !baseline.has(item.fingerprint))
    .map((item) => ({
      ...item,
      message: "Numeric border radius exceeds the 3px control limit and is not an approved legacy exception."
    }));

  const tokenValues = new Map(tokens.map((token) => [token.name, normalizeCssFragment(token.value)]));
  const requiredTokens = new Map([
    ["--portal-radius-structural", "0"],
    ["--portal-radius-control", "3px"],
    ["--portal-radius-pill", "999px"],
    ["--portal-radius-round", "50%"],
    ["--portal-radius", "var(--portal-radius-control)"]
  ]);

  for (const [token, expected] of requiredTokens) {
    const actual = tokenValues.get(token);
    if (actual !== expected) {
      violations.push({
        actual: actual ?? "missing",
        expected,
        message: `Required visual geometry token ${token} must remain ${expected}.`,
        token
      });
    }
  }

  return {
    baselineExceptions: baselineExceptions.length,
    currentExceptions,
    staleExceptions,
    violations
  };
}

function radiusExceedsControlLimit(value) {
  const dimensions = [...value.matchAll(/(-?\d+(?:\.\d+)?)(px|rem|em)\b/g)].map((match) => ({
    pixels: Number(match[1]) * (match[2] === "px" ? 1 : 16),
    raw: match[0]
  }));

  return dimensions.some((dimension) => dimension.pixels > 3 && dimension.raw !== "999px");
}

function normalizeCssFragment(value) {
  return value.trim().replace(/\s+/g, " ");
}

function isKeyframeStep(selector) {
  return selector === "from" || selector === "to" || /^\d+(?:\.\d+)?%$/.test(selector);
}

function isSemanticToken(tokenName) {
  return /^(--portal-|--color|--brand|--accent|--focus|--surface|--border|--state|--shadow|--ease|--duration|--space|--text|--font|--radius|--control)/.test(tokenName);
}

function collectUndefinedCustomProperties(css, definedTokens) {
  const usedTokens = [...new Set([...css.matchAll(/var\((--[a-zA-Z0-9-]+)/g)].map((match) => match[1]))].sort();

  return usedTokens
    .filter((token) => !definedTokens.has(token))
    .map((token) => ({
      kind: classifyCustomProperty(token),
      token
    }));
}

function classifyCustomProperty(token) {
  if (
    /^--(?:avatar|cover|reaction|budget|portal-boot|skill-hub-icon|forum-plugin-icon|linked-item-icon|my-access-token-grid|portal-live-current)/.test(token)
  ) {
    return "component-local";
  }

  return "suspicious";
}

function countOwnership(selectorList) {
  const counts = new Map();

  for (const selector of selectorList) {
    const owner = classifyOwner(selector);
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([owner, count]) => ({ count, owner }));
}

function classifyOwner(selector) {
  const classNames = [...selector.matchAll(/\.([_a-zA-Z][\w-]*)/g)].map((match) => match[1]);
  const candidates = classNames.length > 0 ? classNames : [selector];

  if (candidates.some((name) => /^portal-/.test(name))) return "portal";
  if (candidates.some((name) => /^(apps|skill|resource|handoff|mcpTool|creationObject|category|launch)/i.test(name))) return "apps";
  if (
    candidates.some((name) =>
      /^(forum|discussion|topic|reply|composer|mention|imageNav|embed|markdown|postAction|participant|inlineMention|mdxForum|latestReply|communityStats|attachment|imageDot)/i.test(
        name
      )
    )
  )
    return "forum";
  if (candidates.some((name) => /^(market|skillHub|capability|listing|publisherProfile|ranking|ownedItem)/i.test(name))) return "market";
  if (candidates.some((name) => /^(admin|asset|review|appReview|appCover|organization|allocation|usage)/i.test(name))) return "admin";
  if (candidates.some((name) => /^(llm|gateway)/i.test(name))) return "llmGateway";
  if (candidates.some((name) => /^(my|token|budget|createdToken|dailyUsage)/i.test(name))) return "myPortal";
  if (candidates.some((name) => /^(profile|avatar|crop|identity)/i.test(name))) return "profile";
  if (candidates.some((name) => /^(mcp|agent)/i.test(name))) return "mcpPortal";
  if (candidates.some((name) => /^journey/i.test(name))) return "journey";
  if (candidates.some((name) => /^(home|dashboard|peoplePulse|pulse|builderPresence|commandBar|workbench|intentChips)/i.test(name)))
    return "dashboard";
  if (candidates.some((name) => /^(shell|sidebar|topbar|topActions|brand|nav|language|newMenu|login|portalRoute|portalBoot|unauth|workspace)/i.test(name)))
    return "layout";
  if (
    candidates.some((name) =>
      /^(iconButton|primaryButton|secondaryButton|dangerButton|primaryAction|secondaryAction|iconTextButton|button|panel|stat|sectionHeader|entity|tagRow|kindBadge|statusBadge|riskBadge|personAvatar|avatarStack|ownerLine|activityLine|activityEvent|relativeTime|emptyState|form|table|segmentedControl|modal|squareCover|fieldControl|selectControl|searchControl|modeSwitchButton|typeBadge|fileTypeBadge|iconSelect|accessTarget|detailRows|detailAside|contextRows|calloutBand|eyebrow|cardGrid|contentGrid|compact|filterBar|tagFilter|coverUpload)/i.test(
        name
      )
    )
  )
    return "shared";
  if (selector.startsWith(":root") || selector === "*" || selector === "body" || /^(h1|h2|h3|button|input|select|textarea|a)\b/.test(selector)) return "base";
  return "uncategorized";
}

function countTokenPrefixes(tokens) {
  const counts = new Map();

  for (const token of tokens) {
    const parts = token.replace(/^--/, "").split("-");
    const prefix = parts[0] ?? token;
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([prefix, count]) => ({ count, prefix }));
}

function repeatedValues(values) {
  const counts = new Map();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

function topValues(values, limit) {
  return repeatedValues(values).slice(0, limit);
}

function countMatches(text, pattern) {
  return text.match(pattern)?.length ?? 0;
}

function sum(items, readValue) {
  return items.reduce((total, item) => total + readValue(item), 0);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function printReport(data) {
  console.log("Frontend CSS Health");
  console.log("===================");
  console.log(`CSS source files: ${data.metrics.cssFiles}`);
  console.log(`Lines: ${data.metrics.lineCount}`);
  console.log(`Rule blocks: ${data.metrics.ruleBlocks}`);
  console.log(`Selectors: ${data.metrics.selectors}`);
  console.log(`Root tokens: ${data.metrics.tokenCount} (${data.metrics.semanticTokenCount} semantic)`);
  console.log(`Raw color literals outside :root: ${data.metrics.rawColorLiterals} (${data.metrics.rawHexColors} hex, ${data.metrics.rawRgbColors} rgb/rgba)`);
  console.log(`Legacy alias token uses: ${data.metrics.aliasTokenUses}`);
  console.log(
    `Undefined custom properties: ${data.metrics.undefinedCustomProperties} (${data.metrics.suspiciousUndefinedCustomProperties} suspicious)`
  );
  console.log(`Repeated selector groups across all contexts: ${data.metrics.repeatedSelectors} (${data.metrics.repeatedSelectorOccurrences} occurrences)`);
  console.log(`  repeated within the same cascade context: ${data.metrics.repeatedSameContextGroups}`);
  console.log(`  reused across media/other contexts: ${data.metrics.responsiveSelectorGroups}`);
  console.log(`  present in multiple files: ${data.metrics.crossFileSelectorGroups}`);
  console.log(`  identical selector-rule copies: ${data.metrics.exactDuplicateRuleCopies} across ${data.metrics.exactDuplicateRuleGroups} groups`);
  console.log(`!important usages: ${data.metrics.importantUsages}`);
  console.log(`Media queries: ${data.metrics.mediaQueries}`);
  console.log(`Legacy numeric radius exceptions: ${data.metrics.legacyLargeRadiusExceptions}`);
  console.log(`Visual geometry violations: ${data.metrics.visualGeometryViolations}`);
  console.log("");
  printSection("CSS files", data.cssFiles, (item) => `${item.lines} ${item.path}`);
  printSection("Top style owners", data.ownership.slice(0, 12), (item) => `${item.count} ${item.owner}`);
  printSection("Top token prefixes", data.tokenPrefixes.slice(0, 10), (item) => `${item.count} ${item.prefix}`);
  printSection("Legacy alias token usage", data.aliasUsage.slice(0, 12), (item) => `${item.count} ${item.token}`);
  printSection(
    "Suspicious undefined custom properties",
    data.suspiciousUndefinedCustomProperties,
    (item) => `${item.token} (${item.kind})`
  );
  printSection("Most reused selectors", data.selectorReuse.repeatedSelectors.slice(0, 8), (item) => (
    `${item.occurrences} ${item.selector} [${item.files.length} files; ${item.contexts.join(" | ")}]`
  ));
  printSection("Identical selector-rule copies", data.selectorReuse.exactDuplicateRules.slice(0, 8), (item) => (
    `${item.copies} ${item.selector} [${item.locations.map((location) => `${location.file}:${location.line}`).join(", ")}]`
  ));
  printSection("Repeated raw hex colors", data.topRawHexColors, (item) => `${item.count} ${item.value}`);
  printSection(
    "Visual geometry violations",
    data.radiusPolicy.violations,
    (item) => item.fingerprint ?? `${item.token}: expected ${item.expected}, found ${item.actual}`
  );
  printSection("Retired radius exceptions", data.radiusPolicy.staleExceptions, (item) => item);
  console.log("");
  console.log("Interpretation:");
  console.log("- Raw color literals outside :root are style-token migration candidates, not automatic failures.");
  console.log("- Legacy alias token uses show where old short names still hide ownership intent.");
  console.log("- Repeated selectors are classified by file and at-rule context; responsive overrides are not automatically redundant.");
  console.log("- Identical selector-rule copies are review candidates, not automatic deletions; cascade order still matters.");
  console.log("- Structural surfaces use zero radius; controls use 3px or less; new large numeric radii fail this command.");
}

function printSection(title, rows, format) {
  console.log(title);

  if (rows.length === 0) {
    console.log("  none");
    return;
  }

  for (const row of rows) {
    console.log(`  ${format(row)}`);
  }
}
