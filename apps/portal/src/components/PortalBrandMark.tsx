import { usePlatformBrand } from "../../../../src/portal/brand/PlatformBrandProvider";

export function PortalBrandMark({ className }: { className?: string }) {
  const brand = usePlatformBrand();
  return <span aria-hidden="true" className={className ? `portal-brand-mark ${className}` : "portal-brand-mark"}>
    {brand.logoUrl ? <img src={brand.logoUrl} alt="" /> : brand.logoText === "FW" ? (
      <svg viewBox="0 0 64 64" width="100%" height="100%" focusable="false" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="square" strokeLinejoin="miter">
        <path d="M9 44V20h15M9 31h12" />
        <path d="m28 20 6 24 8-16 8 16 6-24" />
      </svg>
    ) : brand.logoText}
  </span>;
}
