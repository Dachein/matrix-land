import { workspaceModulesFromEnv, type WorkspaceModule } from "../../shared/workspaceModules";
import { publicInstallationEndpoints, type PublicInstallationEndpoints } from "../../shared/installationDomains";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { defaultPlatformBrand, resolvePlatformBrand, type PlatformBrand } from "../../shared/platformBrand";
import { platformCssVariables } from "../../shared/platformPalette";
import { platformBrandIcon } from "../../shared/platformBrandIcon";

const ModulesContext = createContext<WorkspaceModule[]>([]);
const EndpointsContext = createContext<PublicInstallationEndpoints>({});
const BrandContext = createContext<PlatformBrand>({ ...defaultPlatformBrand });
const BrandReadyContext = createContext(true);

export function PlatformBrandProvider({ children, previewBrand }: { children: ReactNode; previewBrand?: PlatformBrand }) {
  const [modules, setModules] = useState<WorkspaceModule[]>([]);
  const [endpoints, setEndpoints] = useState<PublicInstallationEndpoints>({});
  const [brand, setBrand] = useState<PlatformBrand>({ ...defaultPlatformBrand });
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (previewBrand) return;
    const controller = new AbortController();
    void fetch("/api/public/brand", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]), credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error("brand_unavailable");
        const result: unknown = await response.json();
        if (!result || typeof result !== "object" || !("schemaVersion" in result) || result.schemaVersion !== 1 || !("brand" in result)) throw new Error("unsupported_brand_version");
        setBrand(resolvePlatformBrand(result.brand));
        if ("modules" in result) setModules(workspaceModulesFromEnv({ WORKSPACE_MODULES_JSON: JSON.stringify(result.modules) }));
        if ("endpoints" in result && result.endpoints && typeof result.endpoints === "object") {
          const supplied = result.endpoints as PublicInstallationEndpoints;
          setEndpoints(publicInstallationEndpoints({ APPS_BASE_DOMAIN: supplied.appBaseDomain, APPS_APP_HOST_PREFIX: supplied.appHostPrefix, MCP_RESOURCE_URL: supplied.mcpUrl, WORKSPACE_MATE_EMAIL_DOMAIN:supplied.mateEmailDomain,WORKSPACE_EMAIL_ROUTING_DOMAIN:supplied.appEmailDomain }));
        }
      })
      .catch(() => { /* Keep a neutral identity during unavailable local/offline API. */ })
      .finally(() => { if (!controller.signal.aborted) setReady(true); });
    return () => controller.abort();
  }, [previewBrand]);
  const current = previewBrand ?? brand;
  useEffect(() => {
    const root = document.documentElement;
    const variables = platformCssVariables(current);
    const previous = Object.fromEntries(Object.keys(variables).map((key) => [key, root.style.getPropertyValue(key)]));
    for (const [key, value] of Object.entries(variables)) root.style.setProperty(key, value);
    const oldTitle = document.title;
    document.title = current.name;
    const metadata = [
      ['meta[property="og:site_name"]', current.name],
      ['meta[property="og:title"]', current.name],
      ['meta[name="twitter:title"]', current.name],
      ['meta[name="theme-color"]', current.primaryColor]
    ].map(([selector, value]) => {
      const element = document.querySelector<HTMLMetaElement>(selector);
      const previous = element?.getAttribute("content");
      element?.setAttribute("content", value);
      return { element, previous };
    });
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    const oldIcon = icon?.getAttribute("href");
    const oldIconType = icon?.getAttribute("type");
    if (icon) {
      icon.href = platformBrandIcon(current);
      if (current.logoUrl) icon.removeAttribute("type");
      else icon.type = "image/svg+xml";
    }
    return () => {
      for (const [key, value] of Object.entries(previous)) value ? root.style.setProperty(key, value) : root.style.removeProperty(key);
      document.title = oldTitle;
      for (const { element, previous } of metadata) {
        if (previous != null) element?.setAttribute("content", previous);
        else element?.removeAttribute("content");
      }
      if (icon) oldIcon != null ? icon.setAttribute("href", oldIcon) : icon.removeAttribute("href");
      if (icon) oldIconType ? icon.setAttribute("type", oldIconType) : icon.removeAttribute("type");
    };
  }, [current]);
  return <BrandContext.Provider value={current}><BrandReadyContext.Provider value={Boolean(previewBrand) || ready}><EndpointsContext.Provider value={endpoints}><ModulesContext.Provider value={modules}>{children}</ModulesContext.Provider></EndpointsContext.Provider></BrandReadyContext.Provider></BrandContext.Provider>;
}

export function usePlatformBrand() { return useContext(BrandContext); }
export function usePlatformBrandReady() { return useContext(BrandReadyContext); }

export function useInstallationEndpoints() { return useContext(EndpointsContext); }

export function useWorkspaceModules() { return useContext(ModulesContext); }
