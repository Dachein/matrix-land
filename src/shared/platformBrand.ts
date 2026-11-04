import { findPlatformBrandPreset, type PlatformPaletteId } from "./platformBrandPresets.ts";
/** Public identity only. Credentials and service endpoints never belong here. */
export type PlatformBrand = {
  paletteId?: PlatformPaletteId;
  name: string;
  logoText: string;
  logoUrl?: string;
  defaultLocale?: "zh-CN" | "en";
  primaryColor: string;
  accentColor: string;
};

export type PlatformBrandEnv = {
  PLATFORM_BRAND_JSON?: string;
};

// The open-source seed brand. Every installation can override it.
export const defaultPlatformBrand: Readonly<PlatformBrand> = Object.freeze({
  paletteId: "frontier",
  name: "Matrix land",
  logoText: "ML",
  defaultLocale: "zh-CN",
  primaryColor: "#e85e19",
  accentColor: "#66765b"
});

export function resolvePlatformBrand(input: unknown = {}): PlatformBrand {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("invalid_platform_brand");
  }
  const value = input as Record<string, unknown>;
  const allowed = new Set(["name", "logoText", "logoUrl", "primaryColor", "accentColor", "paletteId", "defaultLocale"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("unknown_platform_brand_field");
  }
  const name = brandText(value.name, defaultPlatformBrand.name, 80);
  const logoText = brandText(value.logoText, defaultPlatformBrand.logoText, 8);
  const defaultLocale = value.defaultLocale ?? "zh-CN";
  if (defaultLocale !== "zh-CN" && defaultLocale !== "en") throw new Error("invalid_platform_locale");
  const preset = value.paletteId === undefined ? undefined : findPlatformBrandPreset(value.paletteId);
  if (value.paletteId !== undefined && !preset) throw new Error("invalid_platform_palette");
  const primaryColor = brandColor(value.primaryColor, preset?.primaryColor ?? defaultPlatformBrand.primaryColor);
  const accentColor = brandColor(value.accentColor, preset?.accentColor ?? defaultPlatformBrand.accentColor);
  if (preset && (primaryColor !== preset.primaryColor || accentColor !== preset.accentColor)) throw new Error("platform_palette_color_mismatch");
  const paletteId = preset?.id ?? (value.primaryColor === undefined && value.accentColor === undefined ? "frontier" : undefined);
  const logoUrl = value.logoUrl === undefined ? undefined : publicHttpsUrl(value.logoUrl);
  return { ...(paletteId ? { paletteId } : {}), name, logoText, defaultLocale, ...(logoUrl ? { logoUrl } : {}), primaryColor, accentColor };
}

export function platformBrandFromEnv(env: PlatformBrandEnv): PlatformBrand {
  const raw = env.PLATFORM_BRAND_JSON;
  if (raw === undefined) return resolvePlatformBrand();
  if (typeof raw !== "string" || raw.length > 4096) throw new Error("invalid_platform_brand_json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid_platform_brand_json");
  }
  return resolvePlatformBrand(parsed);
}

export function publicHttpsUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new Error("invalid_public_https_url");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid_public_https_url");
  }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("invalid_public_https_url");
  return url.toString();
}

function brandText(value: unknown, fallback: string, maxLength: number): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("invalid_platform_brand_text");
  }
  return value.trim();
}

function brandColor(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error("invalid_platform_brand_color");
  return value.toLowerCase();
}
