import { Check, Clipboard, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "../../../../src/portal/components/Button";
import { ModalShell } from "../../../../src/portal/components/ModalShell";
import { useI18n } from "../../../../src/portal/i18n";
import "../styles/diagnostics.css";
import type { TranslationKey } from "../../../../src/portal/i18n/resources";
import { collectBrowserDiagnostics, type BrowserDiagnostics } from "../lib/browserDiagnostics";

type DiagnosticRow = {
  label: TranslationKey;
  value: string;
};

type DiagnosticSection = {
  rows: DiagnosticRow[];
  title: TranslationKey;
};

export function BrowserDiagnosticsModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [diagnostics, setDiagnostics] = useState<BrowserDiagnostics>();
  const [copyState, setCopyState] = useState<"copied" | "error" | "idle">("idle");
  const sections = useMemo(() => diagnostics ? buildSections(diagnostics, t) : [], [diagnostics, t]);

  useEffect(() => {
    let cancelled = false;
    void collectBrowserDiagnostics().then((result) => {
      if (!cancelled) {
        setDiagnostics(result);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", closeFromKeyboard);
    return () => document.removeEventListener("keydown", closeFromKeyboard);
  }, [onClose]);

  useEffect(() => {
    if (copyState === "idle") {
      return;
    }

    const timer = window.setTimeout(() => setCopyState("idle"), 1800);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  async function copyDiagnostics() {
    if (!diagnostics) {
      return;
    }

    try {
      await copyText(formatDiagnostics(sections, t));
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  }

  return (
    <ModalShell
      ariaLabel={t("portal.diagnostics.modalAria")}
      header={(
        <div className="portal-diagnostics-heading">
          <span>{t("portal.diagnostics.kicker")}</span>
          <h2>{t("portal.diagnostics.title")}</h2>
          <p>{t("portal.diagnostics.description")}</p>
        </div>
      )}
      headerActions={(
        <Button aria-label={t("common.close")} autoFocus iconBefore={<X size={18} />} onClick={onClose} variant="icon" />
      )}
      headerClassName="portal-diagnostics-header"
      modalClassName="portal-diagnostics-modal"
      onClose={onClose}
      overlayClassName="portal-diagnostics-overlay"
    >
      <div className="portal-diagnostics-body">
        {!diagnostics ? (
          <div className="portal-diagnostics-loading" role="status">{t("portal.diagnostics.loading")}</div>
        ) : (
          <>
            <div className="portal-diagnostics-summary" aria-label={t("portal.diagnostics.summaryAria")}>
              <SummaryItem label={t("portal.diagnostics.browser")} unavailable={t("portal.diagnostics.unavailable")} value={diagnostics.browser} />
              <SummaryItem label={t("portal.diagnostics.operatingSystem")} unavailable={t("portal.diagnostics.unavailable")} value={diagnostics.operatingSystem} />
              <SummaryItem label={t("portal.diagnostics.screen")} unavailable={t("portal.diagnostics.unavailable")} value={diagnostics.screen} />
            </div>

            <div className="portal-diagnostics-sections">
              {sections.map((section) => (
                <section className="portal-diagnostics-section" key={section.title}>
                  <h3>{t(section.title)}</h3>
                  <dl>
                    {section.rows.map((row) => (
                      <div key={row.label}>
                        <dt>{t(row.label)}</dt>
                        <dd>{row.value || t("portal.diagnostics.unavailable")}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </div>
          </>
        )}
      </div>

      <footer className="portal-diagnostics-footer">
        <span aria-live="polite">
          {copyState === "error" ? t("portal.diagnostics.copyFailed") : t("portal.diagnostics.copyHint")}
        </span>
        <Button
          disabled={!diagnostics}
          iconBefore={copyState === "copied" ? <Check size={15} /> : <Clipboard size={15} />}
          onClick={() => void copyDiagnostics()}
          size="compact"
          variant="primary"
        >
          {copyState === "copied" ? t("portal.diagnostics.copied") : t("portal.diagnostics.copy")}
        </Button>
      </footer>
    </ModalShell>
  );
}

function SummaryItem({ label, unavailable, value }: { label: string; unavailable: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value || unavailable}</strong>
    </div>
  );
}

function buildSections(
  diagnostics: BrowserDiagnostics,
  t: ReturnType<typeof useI18n>["t"]
): DiagnosticSection[] {
  const yesNo = (value: boolean) => t(value ? "portal.diagnostics.yes" : "portal.diagnostics.no");
  const deviceType = diagnostics.deviceType === "mobile"
    ? t("portal.diagnostics.device.mobile")
    : diagnostics.deviceType === "tablet"
      ? t("portal.diagnostics.device.tablet")
      : t("portal.diagnostics.device.desktop");
  const colorScheme = diagnostics.colorScheme === "dark"
    ? t("portal.diagnostics.colorScheme.dark")
    : t("portal.diagnostics.colorScheme.light");
  const displayMode = diagnostics.displayMode === "fullscreen"
    ? t("portal.diagnostics.displayMode.fullscreen")
    : diagnostics.displayMode === "standalone"
      ? t("portal.diagnostics.displayMode.standalone")
      : t("portal.diagnostics.displayMode.browser");

  return [
    {
      title: "portal.diagnostics.softwareSection",
      rows: [
        { label: "portal.diagnostics.browser", value: diagnostics.browser },
        { label: "portal.diagnostics.operatingSystem", value: diagnostics.operatingSystem },
        { label: "portal.diagnostics.deviceType", value: deviceType },
        { label: "portal.diagnostics.platform", value: diagnostics.platform },
        { label: "portal.diagnostics.architecture", value: diagnostics.architecture },
        { label: "portal.diagnostics.userAgent", value: diagnostics.userAgent }
      ]
    },
    {
      title: "portal.diagnostics.displaySection",
      rows: [
        { label: "portal.diagnostics.screen", value: diagnostics.screen },
        { label: "portal.diagnostics.physicalScreenEstimate", value: diagnostics.physicalScreenEstimate },
        { label: "portal.diagnostics.availableScreen", value: diagnostics.availableScreen },
        { label: "portal.diagnostics.viewport", value: diagnostics.viewport },
        { label: "portal.diagnostics.visualViewport", value: diagnostics.visualViewport },
        { label: "portal.diagnostics.devicePixelRatio", value: diagnostics.devicePixelRatio },
        { label: "portal.diagnostics.colorDepth", value: diagnostics.colorDepth },
        { label: "portal.diagnostics.orientation", value: diagnostics.orientation },
        { label: "portal.diagnostics.gpu", value: diagnostics.gpu },
        { label: "portal.diagnostics.colorScheme", value: colorScheme },
        { label: "portal.diagnostics.reducedMotion", value: yesNo(diagnostics.reducedMotion) },
        { label: "portal.diagnostics.forcedColors", value: yesNo(diagnostics.forcedColors) }
      ]
    },
    {
      title: "portal.diagnostics.runtimeSection",
      rows: [
        { label: "portal.diagnostics.languages", value: diagnostics.languages },
        { label: "portal.diagnostics.timezone", value: diagnostics.timezone },
        { label: "portal.diagnostics.cpuCores", value: diagnostics.cpuCores },
        { label: "portal.diagnostics.deviceMemory", value: diagnostics.deviceMemory },
        { label: "portal.diagnostics.touchPoints", value: diagnostics.touchPoints },
        { label: "portal.diagnostics.connection", value: diagnostics.connection },
        { label: "portal.diagnostics.storage", value: diagnostics.storage },
        { label: "portal.diagnostics.online", value: yesNo(diagnostics.online) },
        { label: "portal.diagnostics.cookiesEnabled", value: yesNo(diagnostics.cookiesEnabled) },
        { label: "portal.diagnostics.secureContext", value: yesNo(diagnostics.secureContext) },
        { label: "portal.diagnostics.displayMode", value: displayMode },
        { label: "portal.diagnostics.generatedAt", value: diagnostics.generatedAt }
      ]
    }
  ];
}

function formatDiagnostics(sections: DiagnosticSection[], t: ReturnType<typeof useI18n>["t"]) {
  return [
    t("portal.diagnostics.title"),
    ...sections.flatMap((section) => [
      "",
      `[${t(section.title)}]`,
      ...section.rows.map((row) => `${t(row.label)}: ${row.value || t("portal.diagnostics.unavailable")}`)
    ])
  ].join("\n");
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.setAttribute("readonly", "true");
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();

  if (!copied) {
    throw new Error("clipboard_copy_failed");
  }
}
