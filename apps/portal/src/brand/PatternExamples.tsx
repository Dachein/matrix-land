import { useState } from "react";
import { Search, X } from "lucide-react";
import { Button } from "../../../../src/portal/components/Button";
import { PageHeading } from "../../../../src/portal/components/PageHeading";
import { SearchField } from "../../../../src/portal/components/SearchField";
import { EmptyState } from "../../../../src/portal/components/EmptyState";
import { WorkspaceListbox } from "../../../../src/portal/components/WorkspaceListbox";
import { ModalShell } from "../../../../src/portal/components/ModalShell";
import { useI18n } from "../../../../src/portal/i18n";

/** The same page patterns and portaled controls used by business routes. */
export function PatternExamples() {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [value, setValue] = useState("all");
  const [open, setOpen] = useState(false);
  const options = [
    { value: "all", label: t("market.all") },
    { value: "app", label: t("market.apps") },
    { value: "skill", label: t("market.skills") }
  ];
  const visible = options.filter(option => option.value !== "all" && (value === "all" || option.value === value)
    && option.label.toLowerCase().includes(query.trim().toLowerCase()));
  return <section className="studio-section"><span className="studio-number">05</span><div>
    <h2>{t("design.patternsTitle")}</h2><p>{t("design.patternsBody")}</p>
    <PageHeading id="studio-pattern-title" title={t("portal.skillsApps.title")} subtitle={t("design.sampleData")}
      actions={<Button onClick={() => setOpen(true)}>{t("design.openPicker")}</Button>} />
    <div className="studio-pattern-controls">
      <SearchField label={t("portal.skillsApps.searchLabel")} placeholder={t("portal.skillsApps.searchPlaceholder")}
        value={query} onChange={event => setQuery(event.target.value)} />
      <WorkspaceListbox ariaLabel={t("market.typeFilter")} options={options} value={value} onChange={setValue} />
    </div>
    {visible.length ? <div className="studio-pattern-results">{visible.map(option => <div key={option.value}>
      <strong>{option.label}</strong><span>{t("design.sampleData")}</span>
    </div>)}</div> : <EmptyState icon={<Search />} title={t("market.emptyFilteredTitle")}
      description={t("market.emptyFilteredBody")} actions={<Button onClick={() => { setQuery(""); setValue("all"); }}>{t("market.emptyReset")}</Button>} />}
    {open && <ModalShell ariaLabel={t("design.openPicker")} onClose={() => setOpen(false)}
      header={<h2>{t("design.openPicker")}</h2>} headerActions={<Button variant="icon" aria-label={t("design.close")} onClick={() => setOpen(false)}><X /></Button>}>
      <p>{t("design.pickerHelp")}</p>
      <WorkspaceListbox ariaLabel={t("market.typeFilter")} searchable searchPlaceholder={t("portal.skillsApps.searchLabel")}
        noResultsLabel={t("common.noResults")} options={options} value={value} onChange={setValue} />
      <div className="studio-actions"><Button variant="primary" onClick={() => setOpen(false)}>{t("design.confirm")}</Button></div>
    </ModalShell>}
  </div></section>;
}
