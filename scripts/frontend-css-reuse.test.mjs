import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeCssSelectorReuse } from "./frontend-css-reuse.mjs";

describe("frontend CSS selector reuse analysis", () => {
  it("separates responsive overrides from same-context repeated rules", () => {
    const report = analyzeCssSelectorReuse([{
      relativePath: "styles/home.css",
      source: `
        .card { display: grid; }
        @media (max-width: 700px) {
          .card { display: block; }
        }
      `
    }]);

    assert.equal(report.repeatedSelectorGroups, 1);
    assert.equal(report.responsiveSelectorGroups.length, 1);
    assert.equal(report.sameContextSelectorGroups, 0);
    assert.equal(report.exactDuplicateRuleCopies, 0);
    assert.deepEqual(report.repeatedSelectors[0].contexts, [
      "(root)",
      "@media (max-width: 700px)"
    ]);
  });

  it("counts exact copies only when selector, condition, and declarations match", () => {
    const report = analyzeCssSelectorReuse([
      {
        relativePath: "styles/shell.css",
        source: ".handoff { display: grid; gap: 8px; }"
      },
      {
        relativePath: "styles/post.css",
        source: ".handoff { display: grid; gap: 8px; }"
      }
    ]);

    assert.equal(report.crossFileSelectorGroups.length, 1);
    assert.equal(report.exactDuplicateRuleGroups, 1);
    assert.equal(report.exactDuplicateRuleCopies, 1);
    assert.deepEqual(report.exactDuplicateRules[0].locations, [
      { file: "styles/shell.css", line: 1 },
      { file: "styles/post.css", line: 1 }
    ]);
  });

  it("splits selector lists without splitting commas inside functional selectors", () => {
    const report = analyzeCssSelectorReuse([{
      relativePath: "styles/cards.css",
      source: `
        :is(.card, .tile), .panel { color: red; }
        :is(.card, .tile) { color: blue; }
      `
    }]);

    assert.equal(report.repeatedSelectorGroups, 1);
    assert.equal(report.repeatedSelectors[0].selector, ":is(.card, .tile)");
  });
});
