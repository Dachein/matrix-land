import { readFileSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import ts from "typescript";
import { designTokens, designBreakpoints } from "../src/portal/design-system/tokens.ts";

export function inspectDesignCss(source, file = "styles.css") {
  const problems = [];
  const root = postcss.parse(source, { from: file });
  root.walkDecls(decl => {
    const where = `${file}:${decl.source.start.line}`;
    if (decl.important) problems.push(`${where}: !important bypasses component ownership`);
    if (/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|lab|color)\(/i.test(decl.value)) problems.push(`${where}: use a color token`);
    if (/^(?:color|background-color|border-color|fill|stroke)$/.test(decl.prop) && !/^(?:var\(|transparent$|currentColor$|inherit$|none$)/i.test(decl.value)) problems.push(`${where}: use a semantic color`);
    if (/^(?:padding|margin|gap|row-gap|column-gap|border-radius|font-size|transition-duration|animation-duration|z-index)(?:-|$)/.test(decl.prop) && /(?:\d*\.)?\d+(?:px|rem|em|ms|s)\b/.test(decl.value)) problems.push(`${where}: use a scale token`);
    for (const match of decl.value.matchAll(/var\(\s*--fw-([\w-]+)/g)) if (!(match[1] in designTokens)) problems.push(`${where}: undefined token --fw-${match[1]}`);
  });
  root.walkAtRules("media", rule => {
    if (/prefers-color-scheme\s*:\s*dark/.test(rule.params)) problems.push(`${file}: dark mode is outside the product contract`);
    for (const match of rule.params.matchAll(/(?:min|max)-width\s*:\s*(\d+)px/g)) if (!Object.values(designBreakpoints).includes(Number(match[1]))) problems.push(`${file}: use a registered breakpoint`);
  });
  return problems;
}

export function inspectPrimitive(source, file) {
  const problems = [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = node => {
    if (ts.isImportDeclaration(node)) {
      const specifier = node.moduleSpecifier.text;
      if (specifier !== "react" && specifier !== "lucide-react" && !(file.endsWith("FeedbackNotice.tsx") && specifier === "./feedback.css")) problems.push(`${file}: primitive dependency ${specifier} requires explicit review`);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "fetch") problems.push(`${file}: primitives must not load business data`);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return problems;
}

// Covers legacy pages as well as primitives: no focus frames may return through
// a route-specific stylesheet or a composite field's focus-within state.
export function inspectFocusCss(source, file = "styles.css") {
  const problems = [];
  postcss.parse(source, { from: file }).walkRules(rule => {
    if (!/:focus(?:-visible|-within)?\b/.test(rule.selector)) return;
    rule.walkDecls(decl => {
      if (decl.prop === "outline" && !/^(?:none|0(?:px)?)$/.test(decl.value)) {
        problems.push(`${file}:${decl.source.start.line}: focus uses an enclosing outline; use a baseline`);
      }
      if (decl.prop === "box-shadow" && /(?:^|,)\s*(?:inset\s+)?0(?:px)?\s+0(?:px)?\s+0(?:px)?\s+(?!0(?:px)?(?:\s|$))[^\s,]+/.test(decl.value)) {
        problems.push(`${file}:${decl.source.start.line}: focus uses a surrounding shadow; use a baseline`);
      }
    });
  });
  return problems;
}

export function checkDesignSystem(root = process.cwd()) {
  const files = ["src/portal/design-system/components.css", "src/portal/design-system/motion.css", "src/portal/components/feedback.css", "apps/portal/src/brand/brand-studio.css", "apps/portal/src/styles/workspace-login.css"];
  const problems = files.flatMap(file => inspectDesignCss(readFileSync(resolve(root, file), "utf8"), file));
  function inspectFocusDirectory(directory) {
    for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) inspectFocusDirectory(file);
      else if (file.endsWith(".css")) problems.push(...inspectFocusCss(readFileSync(resolve(root, file), "utf8"), file));
    }
  }
  inspectFocusDirectory("src/portal");
  inspectFocusDirectory("apps/portal/src");
  problems.push(...inspectFocusCss(readFileSync(resolve(root, "packages/installer/ui/style.css"), "utf8"), "packages/installer/ui/style.css"));
  for (const name of ["Button", "FormField", "SegmentedControl", "ModalShell", "FeedbackNotice", "Presence"]) {
    const file = `src/portal/components/${name}.tsx`;
    problems.push(...inspectPrimitive(readFileSync(resolve(root, file), "utf8"), file));
  }
  const components = readdirSync(resolve(root, "apps/portal/src/brand")).filter(file => file.endsWith(".tsx"));
  for (const component of components) {
    const file = `apps/portal/src/brand/${component}`;
    const source = readFileSync(resolve(root, file), "utf8");
    if (/<(?:button|input|select|textarea)\b/.test(source)) problems.push(`${file}: compose the existing form/action primitives`);
    if (/#[\da-f]{6}\b/i.test(source)) problems.push(`${file}: do not hardcode brand colors`);
    if (source.split("\n").length > 300) problems.push(`${file}: split component responsibilities before adding more UI`);
  }
  return problems;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkDesignSystem();
  if (problems.length) { console.error(problems.join("\n")); process.exitCode = 1; }
  else console.log("Design system: tokens, primitive boundaries and workbench composition pass.");
}
