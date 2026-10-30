import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";

export type PortalUtilityRailContextValue = {
  host: HTMLElement | null;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  registerPanel: (id: string, onClose: () => void, dismissOnScrim: boolean, variant: PortalUtilityRailVariant) => void;
  unregisterPanel: (id: string) => void;
};

export type PortalUtilityRailVariant = "default" | "wide" | "inline";

const PortalUtilityRailContext = createContext<PortalUtilityRailContextValue | undefined>(undefined);

export function usePortalRightRail() {
  return useContext(PortalUtilityRailContext);
}

export function PortalUtilityRailProvider({
  children,
  value
}: {
  children: ReactNode;
  value: PortalUtilityRailContextValue;
}) {
  return <PortalUtilityRailContext.Provider value={value}>{children}</PortalUtilityRailContext.Provider>;
}

export function PortalUtilityRailPanel({
  children,
  dismissOnScrim = true,
  onClose,
  open,
  variant = "default"
}: {
  children: ReactNode;
  dismissOnScrim?: boolean;
  onClose: () => void;
  open: boolean;
  variant?: PortalUtilityRailVariant;
}) {
  const context = useContext(PortalUtilityRailContext);
  const panelId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    if (!context || !open) {
      return undefined;
    }

    context.registerPanel(panelId, () => onCloseRef.current(), dismissOnScrim, variant);
    return () => context.unregisterPanel(panelId);
  }, [context?.registerPanel, context?.unregisterPanel, dismissOnScrim, open, panelId, variant]);

  if (!open) {
    return null;
  }

  if (!context) {
    return <>{children}</>;
  }

  if (!context.host) {
    return null;
  }

  return createPortal(children, context.host);
}
