import { workspaceModulesFromEnv, type WorkspaceModule } from "../../shared/workspaceModules";
import { publicInstallationEndpoints, type PublicInstallationEndpoints } from "../../shared/installationDomains";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { defaultPlatformBrand, resolvePlatformBrand, type PlatformBrand } from "../../shared/platformBrand";
import { platformCssVariables } from "../../shared/platformPalette";

const ModulesContext = createContext<WorkspaceModule[]>([]);
const EndpointsContext = createContext<PublicInstallationEndpoints>({});
const BrandContext = createContext<PlatformBrand>({ ...defaultPlatformBrand });

export function PlatformBrandProvider({ children, previewBrand }: { children: ReactNode; previewBrand?: PlatformBrand }) {
  const [modules, setModules] = useState<WorkspaceModule[]>([]);
  const [endpoints, setEndpoints] = useState<PublicInstallationEndpoints>({});
  const [brand, setBrand] = useState<PlatformBrand>({ ...defaultPlatformBrand });
  useEffect(() => {
    if (previewBrand) return;
    const controller = new AbortController();
    void fetch("/api/public/brand", { signal: controller.signal, credentials: "same-origin" })
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
      .catch(() => { /* Keep a neutral identity during unavailable local/offline API. */ });
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
    return () => {
      for (const [key, value] of Object.entries(previous)) value ? root.style.setProperty(key, value) : root.style.removeProperty(key);
      document.title = oldTitle;
    };
  }, [current]);
  return <BrandContext.Provider value={current}><EndpointsContext.Provider value={endpoints}><ModulesContext.Provider value={modules}>{children}</ModulesContext.Provider></EndpointsContext.Provider></BrandContext.Provider>;
}

export function usePlatformBrand() { return useContext(BrandContext); }

export function useInstallationEndpoints() { return useContext(EndpointsContext); }

export function useWorkspaceModules() { return useContext(ModulesContext); }
