import assert from "node:assert/strict";
import { test } from "node:test";
import { platformPalette, colorContrast, platformCssVariables, platformChartPalette } from "./platformPalette.ts";
import { resolvePlatformBrand } from "./platformBrand.ts";

test("arbitrary enterprise colors preserve readable controls and links on light surfaces", () => {
  for (const color of ["#ffffff", "#000000", "#ffff00", "#e85e19", "#66765b", "#123456", "#aaaaaa", "#ff00ff"]) {
    const p = platformPalette(resolvePlatformBrand({ primaryColor: color, accentColor: color }));
    assert.equal(p.mode, "light");
    assert.ok(colorContrast(p.primary, p.onPrimary) >= 4.5, color);
    assert.ok(colorContrast(p.primaryInk, p.canvas) >= 4.5, color);
    assert.ok(colorContrast(p.accentInk, p.canvas) >= 4.5, color);
    assert.ok(colorContrast(p.focus, p.canvas) >= 3, color);
    assert.ok(colorContrast(p.primaryOnInverse, p.ink) >= 4.5, color);
  }
});

test("resolved chart colors track every configured palette without CSS variable strings", async () => {
  const { platformBrandPresets } = await import("./platformBrandPresets.ts");
  for (const preset of platformBrandPresets) {
    const palette = platformChartPalette(resolvePlatformBrand({ paletteId: preset.id }));
    assert.equal(palette.heat.length, 5);
    assert.equal(palette.heat.at(-1), preset.primaryColor);
    assert.equal(new Set(palette.heat).size, 5);
    assert.ok(palette.heat.every(color => /^#[\da-f]{6}$/i.test(color)));
  }
});

test("brand changes do not alter surfaces, error or success meaning", () => {
  const a = platformPalette();
  const b = platformPalette(resolvePlatformBrand({ primaryColor: "#ff0000", accentColor: "#00ff00" }));
  for (const key of ["canvas", "paper", "panel", "ink", "muted", "line", "success", "warning", "danger", "info"]) assert.equal(a[key], b[key]);
  assert.equal(platformCssVariables().hasOwnProperty("--portal-red"), false);
});

test("all eight preset pairs resolve exactly and retain readable action text", async () => {
  const { platformBrandPresets } = await import("./platformBrandPresets.ts");
  assert.equal(platformBrandPresets.length, 8);
  assert.equal(new Set(platformBrandPresets.map(item => item.id)).size, 8);
  for (const preset of platformBrandPresets) {
    const brand = resolvePlatformBrand({ paletteId: preset.id });
    assert.equal(brand.primaryColor, preset.primaryColor);
    assert.equal(brand.accentColor, preset.accentColor);
    const palette = platformPalette(brand);
    assert.ok(colorContrast(palette.primary, palette.onPrimary) >= 4.5);
    assert.ok(colorContrast(palette.primaryInk, palette.canvas) >= 4.5);
  }
  assert.throws(() => resolvePlatformBrand({ paletteId: "unknown" }));
  assert.throws(() => resolvePlatformBrand({ paletteId: "forest", primaryColor: "#ffffff" }));
  assert.equal(resolvePlatformBrand({ name: "Existing installation", primaryColor: "#e60012" }).paletteId, undefined);
});
