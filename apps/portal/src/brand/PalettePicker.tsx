import { SegmentedControl } from "../../../../src/portal/components/SegmentedControl";
import { useI18n } from "../../../../src/portal/i18n";
import { platformBrandPresets } from "../../../../src/shared/platformBrandPresets";
import type { PlatformBrand } from "../../../../src/shared/platformBrand";

export function PalettePicker({ brand, onChange }: { brand: PlatformBrand; onChange: (brand: PlatformBrand) => void }) {
  const { t } = useI18n();
  return <section className="studio-palette-picker"><h3>{t("design.palettes")}</h3><p>{t("design.paletteHint")}</p>
    <SegmentedControl appearance="tiles" ariaLabel={t("design.palettes")} className="studio-palette-options" value={brand.paletteId ?? ""} onChange={id => {
      const preset = platformBrandPresets.find(item => item.id === id);
      if (preset) onChange({ ...brand, paletteId: preset.id, primaryColor: preset.primaryColor, accentColor: preset.accentColor });
    }} options={platformBrandPresets.map(preset => ({
      value: preset.id, ariaLabel: t(`design.palette.${preset.id}`), label: <><span className="studio-palette-colors" aria-hidden="true"><i style={{ background: preset.primaryColor }}/><i style={{ background: preset.accentColor }}/></span><span>{t(`design.palette.${preset.id}`)}</span></>
    }))}/>
  </section>;
}
