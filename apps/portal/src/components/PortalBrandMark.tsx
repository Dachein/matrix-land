import { usePlatformBrand } from "../../../../src/portal/brand/PlatformBrandProvider";

export function PortalBrandMark({ className }: { className?: string }) {
  const brand = usePlatformBrand();
  return <span aria-hidden="true" className={className ? `portal-brand-mark ${className}` : "portal-brand-mark"}>
    {brand.logoUrl ? <img src={brand.logoUrl} alt="" /> : brand.logoText}
  </span>;
}
