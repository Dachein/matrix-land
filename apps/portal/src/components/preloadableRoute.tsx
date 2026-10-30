import { createElement, useEffect, useState, type ComponentType } from "react";
import { PortalRouteLoading } from "./PortalRecovery";

/**
 * Route loader whose preload result is also its render cache.
 *
 * React.lazy starts its own suspense lifecycle even when the browser already
 * downloaded a module. Keeping the resolved component here means a hover or
 * focus preload can make the following navigation render synchronously.
 */
export function createPreloadableRoute<Module, Props extends object>(
  loadModule: () => Promise<Module>,
  selectComponent: (module: Module) => ComponentType<Props>
) {
  let resolvedComponent: ComponentType<Props> | undefined;
  let pendingModule: Promise<ComponentType<Props>> | undefined;

  const preload = () => {
    if (resolvedComponent) {
      return Promise.resolve(resolvedComponent);
    }
    if (!pendingModule) {
      pendingModule = loadModule()
        .then((module) => {
          resolvedComponent = selectComponent(module);
          return resolvedComponent;
        })
        .catch((error) => {
          pendingModule = undefined;
          throw error;
        });
    }
    return pendingModule;
  };

  function PreloadableRoute(props: Props) {
    const [Component, setComponent] = useState<ComponentType<Props> | undefined>(() => resolvedComponent);

    useEffect(() => {
      if (Component) {
        return undefined;
      }
      let active = true;
      void preload().then((nextComponent) => {
        if (active) {
          setComponent(() => nextComponent);
        }
      });
      return () => { active = false; };
    }, [Component]);

    return Component ? createElement(Component, props) : <PortalRouteLoading />;
  }

  return { Component: PreloadableRoute, preload };
}
