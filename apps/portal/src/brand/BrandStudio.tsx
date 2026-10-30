import { useState, type CSSProperties } from "react";
import { PlatformBrandProvider } from "../../../../src/portal/brand/PlatformBrandProvider";
import { DesignSystemScope } from "../../../../src/portal/design-system/DesignSystemScope";
import { SegmentedControl } from "../../../../src/portal/components/SegmentedControl";
import { LanguageSwitcher } from "../../../../src/portal/components/LanguageSwitcher";
import { useI18n } from "../../../../src/portal/i18n";
import { defaultPlatformBrand } from "../../../../src/shared/platformBrand";
import { platformPalette } from "../../../../src/shared/platformPalette";
import { BrandControls } from "./BrandControls";
import { FeedbackExamples } from "./FeedbackExamples";
import { PrimitiveExamples } from "./PrimitiveExamples";
import { EmailExamples } from "./EmailExamples";
import "./brand-studio.css";

export function BrandStudio() {
  const { t } = useI18n();
  const [brand, setBrand] = useState({ ...defaultPlatformBrand });
  const [view, setView] = useState("components");
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable");
  const palette = platformPalette(brand);
  const colors = ["primary", "accent", "canvas", "surface", "text", "border", "success", "warning", "danger", "info"] as const;
  const values = [palette.primary, palette.accent, palette.canvas, palette.paper, palette.ink, palette.line, palette.success, palette.warning, palette.danger, palette.info];
  return <PlatformBrandProvider previewBrand={brand}><DesignSystemScope density={density} className="brand-studio">
    <header className="studio-top"><div className="studio-wordmark"><span>›</span> {brand.name}</div><LanguageSwitcher variant="line" /></header>
    <div className="studio-body"><main className="studio-main">
      <div className="studio-intro"><span className="studio-kicker">{t("design.eyebrow")}</span><h1>{t("design.heading")}</h1><p>{t("design.intro")}</p></div>
      <div className="studio-toolbar"><SegmentedControl ariaLabel={t("design.preview")} value={view} onChange={setView} options={[{ value: "components", label: t("design.preview") }, { value: "emails", label: t("design.emails") }]} /><SegmentedControl appearance="quiet" compact ariaLabel={t("design.density")} value={density} onChange={setDensity} options={[{value:"comfortable",label:t("design.comfortable")},{value:"compact",label:t("design.compact")}]} /></div>
      {view === "components" ? <><PrimitiveExamples /><FeedbackExamples /><section className="studio-section"><span className="studio-number">05</span><div><h2>{t("design.colorsTitle")}</h2><p>{t("design.colorsBody")}</p><div className="studio-swatches">{colors.map((color, index) => <div key={color}><i style={{ background: values[index] } as CSSProperties} /><strong>{t(`design.${color}`)}</strong><code>{values[index]}</code></div>)}</div></div></section></> : <EmailExamples brand={brand} />}
      <footer className="studio-caption">{t("design.footer")}</footer>
    </main><BrandControls brand={brand} onChange={setBrand} /></div>
  </DesignSystemScope></PlatformBrandProvider>;
}
