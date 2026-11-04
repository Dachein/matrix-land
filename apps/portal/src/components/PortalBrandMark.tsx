import { usePlatformBrand } from "../../../../src/portal/brand/PlatformBrandProvider";
import { platformBrandIcon } from "../../../../src/shared/platformBrandIcon";

export function PortalBrandMark({ className }: { className?: string }) {
  const brand = usePlatformBrand();
  return <span aria-hidden="true" className={className ? `portal-brand-mark ${className}` : "portal-brand-mark"}>
    <img src={platformBrandIcon(brand)} alt="" />
  </span>;
}
