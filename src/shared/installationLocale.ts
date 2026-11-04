export type InstallationLocale = "zh-CN" | "en";

function supported(value?: string | null): InstallationLocale | undefined {
  if (/^en(?:-|$)/i.test(value ?? "")) return "en";
  if (/^zh(?:-|$)/i.test(value ?? "")) return "zh-CN";
  return undefined;
}

/** A personal choice wins; browser language only applies without installation configuration. */
export function initialInstallationLocale(saved?: string | null, installation?: InstallationLocale, browser?: string): InstallationLocale {
  return supported(saved) ?? installation ?? supported(browser) ?? "zh-CN";
}
