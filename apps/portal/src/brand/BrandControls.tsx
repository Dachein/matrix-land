import { PalettePicker } from "./PalettePicker";
import { Button } from "../../../../src/portal/components/Button";
import { FormField, TextInput, SelectInput } from "../../../../src/portal/components/FormField";
import { useI18n } from "../../../../src/portal/i18n";
import { defaultPlatformBrand, type PlatformBrand } from "../../../../src/shared/platformBrand";

export function BrandControls({ brand, onChange }: { brand: PlatformBrand; onChange: (brand: PlatformBrand) => void }) {
  const { t } = useI18n();
  const download = () => {
    const blob = new Blob([JSON.stringify(brand, null, 2) + "\n"], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "platform-brand.json"; a.click();
    URL.revokeObjectURL(url);
  };
  return <aside className="studio-settings">
    <h2>{t("design.settings")}</h2><p>{t("design.settingsBody")}</p>
    <FormField label={t("design.name")}><TextInput value={brand.name} maxLength={80} onChange={e => onChange({ ...brand, name: e.target.value || defaultPlatformBrand.name })} /></FormField>
    <FormField label={t("design.mark")}><TextInput value={brand.logoText} maxLength={8} onChange={e => onChange({ ...brand, logoText: e.target.value || defaultPlatformBrand.logoText })} /></FormField>
    <FormField label={t("design.defaultLocale")}><SelectInput appearance="line" value={brand.defaultLocale ?? "zh-CN"} onChange={e => onChange({ ...brand, defaultLocale: e.target.value as "zh-CN" | "en" })}><option value="zh-CN">中文</option><option value="en">English</option></SelectInput></FormField>
    <PalettePicker brand={brand} onChange={onChange} />
    <Button onClick={() => onChange({ ...defaultPlatformBrand })}>{t("design.reset")}</Button>
    <div className="studio-note"><strong>{t("design.light")}</strong><p>{t("design.lightHint")}</p></div>
    <Button onClick={download}>{t("design.download")}</Button>
  </aside>;
}
