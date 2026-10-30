import { resolvePlatformBrand, type PlatformBrand } from "./platformBrand.ts";

/** Fixed light surfaces and semantic states; only brand colors vary by installation. */
export const platformSurfaces = Object.freeze({
  canvas: "#f2efe6", paper: "#faf9f3", panel: "#ffffff", ink: "#181611",
  muted: "#68645a", line: "#d4d0c5", success: "#337354", warning: "#946019",
  danger: "#b33c38", info: "#355f91"
});

export function colorContrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const channels = hex.slice(1).match(/../g)!.map((channel) => {
      const c = parseInt(channel, 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

export function mixColor(color: string, target: string, amount: number) {
  const channels = [1, 3, 5].map((index) => Math.round(
    parseInt(color.slice(index, index + 2), 16) * (1 - amount)
    + parseInt(target.slice(index, index + 2), 16) * amount
  ).toString(16).padStart(2, "0"));
  return `#${channels.join("")}`;
}

export function readableBrandInk(color: string, background = platformSurfaces.canvas): string {
  for (let step = 0; step <= 20; step++) {
    const candidate = mixColor(color, "#000000", step / 20);
    if (colorContrast(candidate, background) >= 4.5) return candidate;
  }
  return "#000000";
}

export function onBrandColor(color: string): string {
  return colorContrast(color, "#000000") >= colorContrast(color, "#ffffff") ? "#000000" : "#ffffff";
}

export function platformPalette(input?: PlatformBrand) {
  const brand = resolvePlatformBrand(input);
  return {
    ...platformSurfaces, mode: "light" as const,
    primary: brand.primaryColor, onPrimary: onBrandColor(brand.primaryColor),
    primaryInk: readableBrandInk(brand.primaryColor), primarySoft: mixColor(brand.primaryColor, platformSurfaces.canvas, 0.91),
    primaryHover: mixColor(brand.primaryColor, "#000000", 0.12),
    accent: brand.accentColor, onAccent: onBrandColor(brand.accentColor),
    accentInk: readableBrandInk(brand.accentColor), accentSoft: mixColor(brand.accentColor, platformSurfaces.canvas, 0.9),
    focus: readableBrandInk(brand.primaryColor)
  };
}

export function platformCssVariables(brand?: PlatformBrand): Record<string, string> {
  const p = platformPalette(brand);
  return {
    "--portal-brand-primary": p.primary, "--portal-brand-on-primary": p.onPrimary,
    "--portal-brand-primary-ink": p.primaryInk, "--portal-brand-primary-soft": p.primarySoft,
    "--portal-brand-primary-hover": p.primaryHover, "--portal-brand-accent": p.accent,
    "--portal-brand-on-accent": p.onAccent, "--portal-brand-accent-ink": p.accentInk,
    "--portal-brand-accent-soft": p.accentSoft, "--portal-focus-ring": p.focus
  };
}
