import { onBrandColor } from "./platformPalette.ts";
import { resolvePlatformBrand, type PlatformBrand } from "./platformBrand.ts";

export function platformBrandIcon(input?: PlatformBrand): string {
  const brand = resolvePlatformBrand(input);
  if (brand.logoUrl) return brand.logoUrl;
  const text = brand.logoText.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const size = brand.logoText.length > 3 ? 20 : 28;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${brand.primaryColor}"/><text x="32" y="42" text-anchor="middle" fill="${onBrandColor(brand.primaryColor)}" font-family="Georgia,Times New Roman,serif" font-size="${size}" font-weight="700">${text}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
