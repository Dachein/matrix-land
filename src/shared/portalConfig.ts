import type { PortalBrandConfig, PortalThemeConfig } from "./types";
import { defaultPlatformBrand, type PlatformBrand } from "./platformBrand.ts";
import { platformPalette } from "./platformPalette.ts";
import { platformBrandPresets } from "./platformBrandPresets.ts";

export function portalConfigFromBrand(brand: PlatformBrand): PortalBrandConfig {
  const p = platformPalette(brand);
  const rgb = (hex: string) => [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16)).join(" ");
  const theme: PortalThemeConfig = {
    id: brand.paletteId ?? "installation", label: brand.name,
    primary: p.primary, primaryStrong: p.primaryInk, primarySoft: p.primarySoft,
    primarySurface: p.paper, primaryInk: p.primaryInk, primaryRgb: rgb(p.primary), primaryStrongRgb: rgb(p.primaryInk),
    series: { "50": p.paper, "100": p.primarySoft, "200": p.primarySoft, "500": p.primary, "600": p.primaryInk, "700": p.primaryInk, "900": p.ink }
  };
  return { name: brand.name, shortName: brand.name, productName: brand.name, tagline: "企业 AI 能力入口",
    logoMark: { text: brand.logoText, backgroundColor: p.primary, foregroundColor: p.onPrimary },
    adminName: "Admin Console", userSpaceName: "Workspace", theme };
}
export const defaultPortalConfig = portalConfigFromBrand(defaultPlatformBrand);
export const availablePortalThemes = platformBrandPresets.map(preset => portalConfigFromBrand({ ...defaultPlatformBrand, primaryColor: preset.primaryColor, accentColor: preset.accentColor, paletteId: preset.id }).theme);
