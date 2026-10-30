import { useInstallationEndpoints } from "../../../../src/portal/brand/PlatformBrandProvider";
import {
  BookOpenCheck,
  Braces,
  Check,
  ChevronDown,
  Copy,
  History,
  KeyRound,
  Mail,
  Layers3,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../../../src/portal/components/Button";
import { ModalShell } from "../../../../src/portal/components/ModalShell";
import { useI18n } from "../../../../src/portal/i18n";
import type {
  McpHandbookOperation,
  McpHandbookPayload,
  McpHandbookRelease,
  McpHandbookTool
} from "../../../../src/shared/mcpHandbook";
import { WORKSPACE_AI_CLI_VERSION, WORKSPACE_AUTH_SDK_VERSION, WORKSPACE_MAIL_SDK_VERSION } from "../../../../src/shared/workspaceProductFamily";
import { PortalRouteLoading } from "../components/PortalRecovery";
import { loadMcpHandbook } from "../mcp/handbookApi";
import {
  MCP_HANDBOOK_MODULES,
  handbookModule,
  latestHandbookFeatures,
  localizedHandbookCopy
} from "../mcp/handbookView";
import { toolDescriptionZh, toolMatchesHandbookQuery } from "../mcp/toolDescriptionsZh";
import "../styles/mcp-handbook.css";

const AUTH_SDK_PACKAGE = `@frontier-workspace/auth · v${WORKSPACE_AUTH_SDK_VERSION}`;
const CLI_INSTALL_COMMAND = `npm install -g ./frontier-workspace-cli-${WORKSPACE_AI_CLI_VERSION}.tgz`;
const GROUP_ORDER = MCP_HANDBOOK_MODULES.map((module) => module.id);
const OPERATION_ORDER: McpHandbookOperation[] = ["read", "write", "approval"];
const RELEASE_HISTORY_CLOSE_ID = "mcp-release-history-close";
const RELEASE_HISTORY_TRIGGER_ID = "mcp-release-history-trigger";
type DeveloperProductId = "mcp" | "authSdk" | "mailSdk" | "cli";

export function PortalMcpHandbook() {
  const { locale, t } = useI18n();
  const installation = useInstallationEndpoints();
  const [handbook, setHandbook] = useState<McpHandbookPayload>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<(typeof GROUP_ORDER)[number] | "all">("all");
  const [operation, setOperation] = useState<McpHandbookOperation | "all">("all");
  const [copiedTool, setCopiedTool] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<DeveloperProductId>("mcp");
  const [selectedModule, setSelectedModule] = useState<(typeof GROUP_ORDER)[number]>("forum-hub");
  const [releaseHistoryOpen, setReleaseHistoryOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      setHandbook(await loadMcpHandbook());
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!releaseHistoryOpen) return undefined;

    const focusCloseButton = window.requestAnimationFrame(() => {
      document.getElementById(RELEASE_HISTORY_CLOSE_ID)?.focus();
    });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setReleaseHistoryOpen(false);
      window.requestAnimationFrame(() => {
        document.getElementById(RELEASE_HISTORY_TRIGGER_ID)?.focus();
      });
    };
    window.addEventListener("keydown", closeOnEscape);

    return () => {
      window.cancelAnimationFrame(focusCloseButton);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [releaseHistoryOpen]);

  const filteredTools = useMemo(() => {
    return (handbook?.tools ?? []).filter((tool) => (
      (group === "all" || tool.group === group)
      && (operation === "all" || tool.operation === operation)
      && toolMatchesHandbookQuery(tool, query)
    ));
  }, [group, handbook?.tools, operation, query]);

  const groupedTools = useMemo(() => GROUP_ORDER.map((id) => ({
    id,
    tools: filteredTools.filter((tool) => tool.group === id)
  })).filter((entry) => entry.tools.length > 0), [filteredTools]);

  const copyToolName = useCallback(async (name: string) => {
    await navigator.clipboard.writeText(name);
    setCopiedTool(name);
    window.setTimeout(() => setCopiedTool((current) => current === name ? "" : current), 1600);
  }, []);

  const clearFilters = () => {
    setQuery("");
    setGroup("all");
    setOperation("all");
  };

  const closeReleaseHistory = useCallback(() => {
    setReleaseHistoryOpen(false);
    window.requestAnimationFrame(() => {
      document.getElementById(RELEASE_HISTORY_TRIGGER_ID)?.focus();
    });
  }, []);

  if (loading && !handbook) {
    return <PortalRouteLoading variant="handbook" />;
  }

  if (error || !handbook) {
    return (
      <div className="portal-workspace-inner portal-mcp-handbook-workspace">
        <section className="mcp-handbook-state error" role="alert">
          <BookOpenCheck size={22} />
          <div><h1>{t("mcp.handbook.loadFailed")}</h1><p>{t("mcp.handbook.loadFailedBody")}</p></div>
          <Button iconBefore={<RefreshCw size={15} />} onClick={() => void load()} variant="primary">
            {t("mcp.handbook.retry")}
          </Button>
        </section>
      </div>
    );
  }

  const productDetails = {
    mcp: {
      Icon: Braces,
      name: "Workspace MCP",
      version: handbook.server.version,
      summary: t("mcp.handbook.product.mcp"),
      cardMeta: t("mcp.handbook.product.mcpTools", { count: handbook.summary.toolCount }),
      kicker: t("mcp.handbook.productHero.mcpKicker"),
      title: t("mcp.handbook.title"),
      body: t("mcp.handbook.subtitle"),
      detailLabel: t("mcp.handbook.endpoint"),
      detailValue: installation.mcpUrl ? `${installation.mcpUrl}/mcp` : "—"
    },
    authSdk: {
      Icon: KeyRound,
      name: "Workspace Auth SDK",
      version: WORKSPACE_AUTH_SDK_VERSION,
      summary: t("mcp.handbook.product.authSdk"),
      cardMeta: "@frontier-workspace/auth",
      kicker: t("mcp.handbook.productHero.authSdkKicker"),
      title: "WORKSPACE AUTH SDK",
      body: t("mcp.handbook.productHero.authSdkBody"),
      detailLabel: t("mcp.handbook.productHero.package"),
      detailValue: AUTH_SDK_PACKAGE
    },
    mailSdk: {
      Icon: Mail,
      name: "Workspace Mail SDK",
      version: WORKSPACE_MAIL_SDK_VERSION,
      summary: t("mcp.handbook.product.mailSdk"),
      cardMeta: "@frontier-workspace/mail",
      kicker: t("mcp.handbook.productHero.mailSdkKicker"),
      title: "WORKSPACE MAIL SDK",
      body: t("mcp.handbook.productHero.mailSdkBody"),
      detailLabel: t("mcp.handbook.productHero.install"),
      detailValue: `@frontier-workspace/mail ${WORKSPACE_MAIL_SDK_VERSION}`
    },
    cli: {
      Icon: TerminalSquare,
      name: "Frontier Workspace CLI",
      version: WORKSPACE_AI_CLI_VERSION,
      summary: t("mcp.handbook.product.cli"),
      cardMeta: "@frontier-workspace/cli",
      kicker: t("mcp.handbook.productHero.cliKicker"),
      title: "Frontier Workspace CLI",
      body: t("mcp.handbook.productHero.cliBody"),
      detailLabel: t("mcp.handbook.productHero.install"),
      detailValue: CLI_INSTALL_COMMAND
    }
  } satisfies Record<DeveloperProductId, {
    Icon: typeof Braces;
    name: string;
    version: string;
    summary: string;
    cardMeta: string;
    kicker: string;
    title: string;
    body: string;
    detailLabel: string;
    detailValue: string;
  }>;
  const selectedProductDetails = productDetails[selectedProduct];
  const SelectedProductIcon = selectedProductDetails.Icon;
  const selectedModuleDetails = handbookModule(selectedModule);
  const selectedModuleCopy = localizedHandbookCopy(locale, selectedModuleDetails.description);
  const selectedModulePacks = (handbook.capabilityPacks ?? []).filter((pack) => pack.group === selectedModule);

  return (
    <div className="portal-workspace-inner portal-mcp-handbook-workspace">
      <article className="mcp-handbook-page">
        <header className="mcp-handbook-hero">
          <div aria-live="polite" className="mcp-handbook-hero-copy">
            <span className="mcp-handbook-kicker"><SelectedProductIcon size={15} /> {selectedProductDetails.kicker}</span>
            <h1>{selectedProductDetails.title}</h1>
            <p>{selectedProductDetails.body}</p>
            <div className="mcp-handbook-endpoint">
              <span>{selectedProductDetails.detailLabel}</span>
              <code>{selectedProductDetails.detailValue}</code>
              <Button size="compact" onClick={()=>void copyToolName(selectedProductDetails.detailValue)}>{copiedTool===selectedProductDetails.detailValue?t("apps.copy.copied"):t("apps.resources.copyTitle")}</Button>
            </div>
          </div>
          <aside aria-label={t("mcp.handbook.productFamilyAria")} className="mcp-handbook-product-family">
            <header>
              <span>{t("mcp.handbook.productFamily")}</span>
              <small>{t("mcp.handbook.productFamilyCurrent")}</small>
            </header>
            {(Object.entries(productDetails) as [DeveloperProductId, typeof productDetails[DeveloperProductId]][]).map(([id, product]) => {
              const ProductIcon = product.Icon;
              const active = id === selectedProduct;
              return (
                <button
                  aria-pressed={active}
                  className={`mcp-handbook-product-card${active ? " is-active" : ""}`}
                  key={id}
                  onClick={() => setSelectedProduct(id)}
                  type="button"
                >
                  <div><ProductIcon size={16} /><span>{product.name}</span></div>
                  <strong>v{product.version}</strong>
                  <p>{product.summary}</p>
                  <small><code>{product.cardMeta}</code></small>
                </button>
              );
            })}
          </aside>
        </header>

        <section className="mcp-handbook-section">
          <div className="mcp-handbook-section-heading">
            <span><Layers3 size={18} /></span>
            <div>
              <h2>{t("mcp.handbook.frameworkTitle")}</h2>
              <p>{t("mcp.handbook.frameworkBody")}</p>
            </div>
          </div>
          <div className="mcp-handbook-framework-note">
            <ShieldCheck size={17} />
            <p>{t("mcp.handbook.stageGuidance")}</p>
          </div>
          <div aria-label={t("mcp.handbook.moduleSelectorAria")} className="mcp-handbook-module-selector" role="group">
            {MCP_HANDBOOK_MODULES.map((module, index) => {
              const active = module.id === selectedModule;
              return (
                <button
                  aria-controls="mcp-handbook-module-detail"
                  aria-pressed={active}
                  className={`mcp-handbook-module-button${active ? " is-active" : ""}`}
                  key={module.id}
                  onClick={() => setSelectedModule(module.id)}
                  type="button"
                >
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{t(`mcp.handbook.group.${module.id}`)}</strong>
                  <small>{handbook.groups.find((entry) => entry.id === module.id)?.count ?? 0}</small>
                </button>
              );
            })}
          </div>
          <section aria-live="polite" className="mcp-handbook-module-detail" id="mcp-handbook-module-detail">
            <header>
              <span>{t("mcp.handbook.selectedModule")}</span>
              <h3>{t(`mcp.handbook.group.${selectedModuleDetails.id}`)}</h3>
              <p>{selectedModuleCopy.primary}</p>
              <p className="mcp-handbook-module-translation" lang={selectedModuleCopy.secondaryLocale}>
                {selectedModuleCopy.secondary}
              </p>
            </header>
            <div className="mcp-handbook-pack-list">
              {selectedModulePacks.map((pack, index) => (
                <details key={pack.id}>
                  <summary>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <span className="mcp-handbook-pack-title">
                      <strong>{locale === "zh-CN" ? pack.titleZh : pack.title}</strong>
                      <small lang={pack.namespace ? undefined : locale === "zh-CN" ? "en" : "zh-CN"}>{pack.namespace ?? (locale === "zh-CN" ? pack.title : pack.titleZh)}</small>
                    </span>
                    <small>{t("mcp.handbook.packCount", { count: pack.count })}</small>
                    <ChevronDown aria-hidden="true" size={16} />
                  </summary>
                  <p>{locale === "zh-CN" ? pack.descriptionZh : pack.description}</p>
                  <p className="mcp-handbook-pack-translation" lang={locale === "zh-CN" ? "en" : "zh-CN"}>
                    {locale === "zh-CN" ? pack.description : pack.descriptionZh}
                  </p>
                  <ul>{pack.toolNames.map((name) => <li key={name}><code>{name}</code></li>)}</ul>
                </details>
              ))}
            </div>
          </section>
        </section>

        <section className="mcp-handbook-section">
          <div className="mcp-handbook-section-heading mcp-handbook-section-heading-with-action">
            <span><Sparkles size={18} /></span>
            <div><h2>{t("mcp.handbook.latestFeatures")}</h2><p>{t("mcp.handbook.latestFeaturesBody")}</p></div>
            <Button
              iconBefore={<History size={16} />}
              id={RELEASE_HISTORY_TRIGGER_ID}
              onClick={() => setReleaseHistoryOpen(true)}
              variant="secondary"
            >
              {t("mcp.handbook.releaseHistory")}
            </Button>
          </div>
          <div className="mcp-handbook-feature-grid">
            {latestHandbookFeatures(handbook.latestFeatures).map((feature, index) => (
              <article className="mcp-handbook-feature" key={feature.id}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <h3>{locale === "zh-CN" ? feature.titleZh : feature.title}</h3>
                <p>{locale === "zh-CN" ? feature.descriptionZh : feature.description}</p>
              </article>
            ))}
          </div>
        </section>

        <div className="mcp-handbook-doc-layout">
          <main className="mcp-handbook-catalog">
            <section className="mcp-handbook-catalog-header">
              <div>
                <span className="mcp-handbook-eyebrow">{t("mcp.handbook.apiReference")}</span>
                <h2>{t("mcp.handbook.catalogTitle")}</h2>
                <p>{t("mcp.handbook.catalogBody")}</p>
              </div>
              <span aria-atomic="true" aria-live="polite" className="mcp-handbook-result-count">
                {t("mcp.handbook.results", { count: filteredTools.length })}
              </span>
            </section>

            <div className="mcp-handbook-filters">
              <label className="mcp-handbook-search">
                <Search size={16} />
                <span className="visuallyHidden">{t("mcp.handbook.searchLabel")}</span>
                <input onChange={(event) => setQuery(event.target.value)} placeholder={t("mcp.handbook.searchPlaceholder")} type="search" value={query} />
              </label>
              <label>
                <span className="visuallyHidden">{t("mcp.handbook.groupFilter")}</span>
                <select aria-label={t("mcp.handbook.groupFilter")} onChange={(event) => setGroup(event.target.value as (typeof GROUP_ORDER)[number] | "all")} value={group}>
                  <option value="all">{t("mcp.handbook.allGroups")}</option>
                  {GROUP_ORDER.map((id) => <option key={id} value={id}>{t(`mcp.handbook.group.${id}`)}</option>)}
                </select>
              </label>
              <label>
                <span className="visuallyHidden">{t("mcp.handbook.operationFilter")}</span>
                <select aria-label={t("mcp.handbook.operationFilter")} onChange={(event) => setOperation(event.target.value as McpHandbookOperation | "all")} value={operation}>
                  <option value="all">{t("mcp.handbook.allOperations")}</option>
                  {OPERATION_ORDER.map((id) => <option key={id} value={id}>{t(`mcp.handbook.operation.${id}`)}</option>)}
                </select>
              </label>
            </div>

            {groupedTools.length > 0 ? groupedTools.map((entry) => (
              <section className="mcp-handbook-tool-group" key={entry.id}>
                <header>
                  <div>
                    <span>{entry.id.toUpperCase()}</span>
                    <h3>{t(`mcp.handbook.group.${entry.id}`)}</h3>
                    <p>{t(`mcp.handbook.groupSummary.${entry.id}`)}</p>
                  </div>
                  <strong>{entry.tools.length}</strong>
                </header>
                <div className="mcp-handbook-tools">
                  {entry.tools.map((tool) => (
                    <ToolReference
                      copied={copiedTool === tool.name}
                      key={tool.name}
                      onCopy={() => void copyToolName(tool.name)}
                      tool={tool}
                    />
                  ))}
                </div>
              </section>
            )) : (
              <section className="mcp-handbook-empty">
                <Search size={22} />
                <h3>{t("mcp.handbook.noResults")}</h3>
                <p>{t("mcp.handbook.noResultsBody")}</p>
                <Button onClick={clearFilters} variant="secondary">{t("mcp.handbook.clearFilters")}</Button>
              </section>
            )}
          </main>

          <aside className="mcp-handbook-aside">
            <section className="mcp-handbook-dynamic-note">
              <ShieldCheck size={20} />
              <h3>{t("mcp.handbook.dynamicTitle")}</h3>
              <p>{t("mcp.handbook.dynamicBody")}</p>
            </section>
            <section className="mcp-handbook-contract-note">
              <span>{t("mcp.handbook.catalogRevision")}</span>
              <code>{handbook.catalogRevision}</code>
              <small>{t("mcp.handbook.generatedAt", { date: formatDate(handbook.generatedAt, locale, true) })}</small>
            </section>
          </aside>
        </div>

        {releaseHistoryOpen && (
          <ReleaseHistoryModal
            locale={locale}
            onClose={closeReleaseHistory}
            releases={handbook.releases}
          />
        )}
      </article>
    </div>
  );
}

function ReleaseHistoryModal({
  locale,
  onClose,
  releases
}: {
  locale: "zh-CN" | "en";
  onClose: () => void;
  releases: McpHandbookRelease[];
}) {
  const { t } = useI18n();

  return (
    <ModalShell
      ariaLabel={t("mcp.handbook.releaseHistory")}
      header={(
        <div>
          <span className="mcp-handbook-eyebrow"><History size={16} /> {t("mcp.handbook.releases")}</span>
          <h2>{t("mcp.handbook.releaseHistory")}</h2>
          <p>{t("mcp.handbook.releaseHistoryBody")}</p>
        </div>
      )}
      headerActions={(
        <Button aria-label={t("common.close")} id={RELEASE_HISTORY_CLOSE_ID} onClick={onClose} variant="icon">
          <X size={20} />
        </Button>
      )}
      headerClassName="mcp-handbook-release-modal-header"
      modalClassName="mcp-handbook-release-modal"
      onClose={onClose}
      overlayClassName="mcp-handbook-release-modal-overlay"
    >
      <div className="mcp-handbook-release-modal-body">
        {releases.map((release, index) => (
          <article className="mcp-handbook-release-entry" key={release.version}>
            <header>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>v{release.version}</strong>
              <time dateTime={release.releasedAt}>{formatDate(release.releasedAt, locale)}</time>
            </header>
            <ul>{(locale === "zh-CN" ? release.changesZh : release.changes).map((change) => <li key={change}>{change}</li>)}</ul>
          </article>
        ))}
      </div>
    </ModalShell>
  );
}

function ToolReference({ copied, onCopy, tool }: { copied: boolean; onCopy: () => void; tool: McpHandbookTool }) {
  const { locale, t } = useI18n();
  const installation = useInstallationEndpoints();
  const parameters = schemaParameters(tool.inputSchema);
  const descriptionZh = toolDescriptionZh(tool.name);

  return (
    <details className="mcp-handbook-tool">
      <summary>
        <span className={`mcp-handbook-operation ${tool.operation}`}>{t(`mcp.handbook.operation.${tool.operation}`)}</span>
        <div>
          <code>{tool.name}</code>
          <p className="mcp-handbook-tool-description-primary">{locale === "zh-CN" ? descriptionZh : tool.description}</p>
          <p className="mcp-handbook-tool-description-secondary" lang={locale === "zh-CN" ? "en" : "zh-CN"}>
            {locale === "zh-CN" ? tool.description : descriptionZh}
          </p>
        </div>
        <span className="mcp-handbook-tool-version">v{tool.version}</span>
        <ChevronDown aria-hidden="true" className="mcp-handbook-chevron" size={17} />
      </summary>
      <div className="mcp-handbook-tool-body">
        <div className="mcp-handbook-tool-body-heading">
          <div><span>{t("mcp.handbook.inputSchema")}</span><strong>{t("mcp.handbook.parameters")}</strong></div>
          <button aria-label={t("mcp.handbook.copyToolName", { name: tool.name })} onClick={onCopy} type="button">
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {t(copied ? "mcp.handbook.copied" : "mcp.handbook.copy")}
          </button>
        </div>
        {parameters.length > 0 ? (
          <div className="mcp-handbook-parameter-table" role="table">
            <div className="mcp-handbook-parameter-head" role="row">
              <span role="columnheader">{t("mcp.handbook.parameter")}</span>
              <span role="columnheader">{t("mcp.handbook.type")}</span>
              <span role="columnheader">{t("mcp.handbook.requirement")}</span>
              <span role="columnheader">{t("mcp.handbook.description")}</span>
            </div>
            {parameters.map((parameter) => (
              <div className="mcp-handbook-parameter-row" key={parameter.name} role="row">
                <code role="cell">{parameter.name}</code>
                <span role="cell">{parameter.type}</span>
                <span role="cell">{t(parameter.required ? "mcp.handbook.required" : "mcp.handbook.optional")}</span>
                <p role="cell">{parameter.description || "—"}</p>
              </div>
            ))}
          </div>
        ) : <p className="mcp-handbook-no-parameters">{t("mcp.handbook.noParameters")}</p>}
      </div>
    </details>
  );
}

type SchemaValue = {
  const?: unknown;
  description?: unknown;
  enum?: unknown;
  items?: unknown;
  type?: unknown;
};

function schemaParameters(inputSchema: Record<string, unknown>) {
  const actionBranches = Array.isArray(inputSchema.oneOf)
    ? inputSchema.oneOf.filter(isRecord)
    : [];
  if (actionBranches.length > 0) {
    const actions = actionBranches
      .map((branch) => isRecord(branch.properties) && isRecord(branch.properties.action)
        ? branch.properties.action.const
        : undefined)
      .filter((action): action is string => typeof action === "string");
    const actionParameter = {
      description: "Select exactly one operation.",
      name: "action",
      required: true,
      type: actions.join(" | ")
    };
    const branchParameters = actionBranches.flatMap((branch) => {
      const properties = isRecord(branch.properties) ? branch.properties : {};
      const action = isRecord(properties.action) && typeof properties.action.const === "string"
        ? properties.action.const
        : "action";
      const required = new Set(Array.isArray(branch.required)
        ? branch.required.filter((name): name is string => typeof name === "string")
        : []);
      return Object.entries(properties)
        .filter(([name]) => name !== "action")
        .map(([name, rawSchema]) => {
          const schema: SchemaValue = isRecord(rawSchema) ? rawSchema : {};
          return {
            description: typeof schema.description === "string" ? schema.description : "",
            name: `${action}.${name}`,
            required: required.has(name),
            type: schemaType(schema)
          };
        });
    });
    return [actionParameter, ...branchParameters];
  }

  const properties = isRecord(inputSchema.properties) ? inputSchema.properties : {};
  const required = new Set(Array.isArray(inputSchema.required)
    ? inputSchema.required.filter((name): name is string => typeof name === "string")
    : []);

  return Object.entries(properties).map(([name, rawSchema]) => {
    const schema: SchemaValue = isRecord(rawSchema) ? rawSchema : {};
    return {
      description: typeof schema.description === "string" ? schema.description : "",
      name,
      required: required.has(name),
      type: schemaType(schema)
    };
  });
}

function schemaType(schema: SchemaValue) {
  if (schema.const !== undefined) return String(schema.const);
  if (Array.isArray(schema.enum)) {
    return schema.enum.map(String).join(" | ");
  }

  if (schema.type === "array") {
    const items = isRecord(schema.items) && typeof schema.items.type === "string" ? schema.items.type : "value";
    return `${items}[]`;
  }

  return typeof schema.type === "string" ? schema.type : "any";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatDate(value: string, locale: "zh-CN" | "en", includeTime = false) {
  const date = new Date(value.includes("T") ? value : `${value}T00:00:00Z`);
  return new Intl.DateTimeFormat(locale, includeTime
    ? { dateStyle: "medium", timeStyle: "short" }
    : { dateStyle: "medium" }).format(date);
}
