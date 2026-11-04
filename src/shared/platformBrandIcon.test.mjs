import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { platformBrandIcon } from "./platformBrandIcon.ts";
import { resolvePlatformBrand } from "./platformBrand.ts";

test("product mark and favicon share a safe brand-controlled vector", () => {
  const icon = decodeURIComponent(platformBrandIcon().split(",")[1]);
  assert.match(icon, />ML<\/text>/);
  assert.match(icon, /#e85e19/);
  assert.doesNotMatch(icon, />FW</);
  for (const name of ["matrix-land-mark.svg", "frontier-mark.svg"]) {
    assert.equal(readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8").trim(), icon);
  }
  const escaped = decodeURIComponent(platformBrandIcon(resolvePlatformBrand({ logoText: "<tag>" })).split(",")[1]);
  assert.match(escaped, /&lt;tag&gt;/);
  assert.doesNotMatch(escaped, /<tag>/);
  const brand = resolvePlatformBrand({ logoUrl: "https://example.com/brand.svg" });
  assert.equal(platformBrandIcon(brand), brand.logoUrl);
});
