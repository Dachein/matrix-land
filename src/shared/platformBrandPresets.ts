/** Reviewed light-mode pairs. Illustration art direction is independent of these palettes. */
export const platformBrandPresets = [
  { id: "frontier", primaryColor: "#e85e19", accentColor: "#66765b" },
  { id: "ocean", primaryColor: "#285a83", accentColor: "#819792" },
  { id: "forest", primaryColor: "#35624b", accentColor: "#b49565" },
  { id: "ink", primaryColor: "#292b2e", accentColor: "#7c8d9b" },
  { id: "plum", primaryColor: "#695178", accentColor: "#b78883" },
  { id: "clay", primaryColor: "#a64e38", accentColor: "#7c8563" },
  { id: "teal", primaryColor: "#27686b", accentColor: "#b4986b" },
  { id: "indigo", primaryColor: "#4c538b", accentColor: "#aa9256" }
] as const;
export type PlatformPaletteId = typeof platformBrandPresets[number]["id"];
export function findPlatformBrandPreset(value: unknown) {
  return platformBrandPresets.find(preset => preset.id === value);
}
