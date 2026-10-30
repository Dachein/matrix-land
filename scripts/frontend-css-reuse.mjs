import postcss from "postcss";

export function analyzeCssSelectorReuse(cssFiles) {
  const occurrences = [];

  for (const file of cssFiles) {
    const root = postcss.parse(file.source, { from: file.relativePath });
    root.walkRules((rule) => {
      if (hasKeyframesAncestor(rule)) {
        return;
      }

      const context = atRuleContext(rule);
      const declarations = (rule.nodes ?? [])
        .filter((node) => node.type === "decl")
        .map((node) => `${node.prop.trim()}:${node.value.trim()}${node.important ? " !important" : ""}`);
      if (declarations.length === 0) {
        return;
      }

      for (const selector of postcss.list.comma(rule.selector).map((part) => part.trim()).filter(Boolean)) {
        occurrences.push({
          context,
          declarations,
          file: file.relativePath,
          line: rule.source?.start?.line ?? 0,
          selector
        });
      }
    });
  }

  const selectors = groupBy(occurrences, (item) => item.selector);
  const exactRules = groupBy(occurrences, (item) => JSON.stringify([
    item.selector,
    item.context,
    item.declarations
  ]));
  const repeatedSelectors = [...selectors.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([selector, items]) => ({
      contexts: [...new Set(items.map((item) => item.context))].sort(),
      files: [...new Set(items.map((item) => item.file))].sort(),
      occurrences: items.length,
      selector
    }))
    .sort(byOccurrences);
  const exactDuplicateRules = [...exactRules.values()]
    .filter((items) => items.length > 1)
    .map((items) => ({
      copies: items.length,
      locations: items.map(({ file, line }) => ({ file, line })),
      selector: items[0].selector
    }))
    .sort((left, right) => right.copies - left.copies || left.selector.localeCompare(right.selector));
  const responsiveSelectorGroups = repeatedSelectors.filter((group) => (
    group.contexts.length > 1 && group.contexts.some((context) => context.includes("@media "))
  ));
  const crossFileSelectorGroups = repeatedSelectors.filter((group) => group.files.length > 1);
  const sameContextSelectorGroups = [...groupBy(occurrences, (item) => JSON.stringify([
    item.selector,
    item.context
  ])).values()].filter((items) => items.length > 1);

  return {
    crossFileSelectorGroups,
    exactDuplicateRuleCopies: exactDuplicateRules.reduce((total, group) => total + group.copies - 1, 0),
    exactDuplicateRuleGroups: exactDuplicateRules.length,
    exactDuplicateRules: exactDuplicateRules.slice(0, 12),
    repeatedSelectorGroups: repeatedSelectors.length,
    repeatedSelectors: repeatedSelectors.slice(0, 12),
    responsiveSelectorGroups,
    sameContextSelectorGroups: sameContextSelectorGroups.length,
    selectorOccurrences: occurrences.length
  };
}

function atRuleContext(rule) {
  const context = [];
  let parent = rule.parent;

  while (parent && parent.type !== "root") {
    if (parent.type === "atrule") {
      context.push(`@${parent.name}${parent.params ? ` ${parent.params.trim()}` : ""}`);
    }
    parent = parent.parent;
  }

  return context.reverse().join(" > ") || "(root)";
}

function hasKeyframesAncestor(rule) {
  let parent = rule.parent;
  while (parent && parent.type !== "root") {
    if (parent.type === "atrule" && /keyframes$/i.test(parent.name)) {
      return true;
    }
    parent = parent.parent;
  }
  return false;
}

function groupBy(items, getKey) {
  const groups = new Map();
  for (const item of items) {
    const key = getKey(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

function byOccurrences(left, right) {
  return right.occurrences - left.occurrences || left.selector.localeCompare(right.selector);
}
