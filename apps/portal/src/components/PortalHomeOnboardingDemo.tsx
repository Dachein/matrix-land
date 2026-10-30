import {
  AppWindow,
  ArrowRight,
  Bot,
  Check,
  Copy,
  Download,
  FileCheck2,
  FileText,
  LockKeyhole,
  Share2,
  ShieldCheck,
  Sparkles,
  TableProperties,
  Users
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useI18n } from "../../../../src/portal/i18n";
import "../styles/home-onboarding-demo.css";

type DemoStep = 0 | 1 | 2;

export function AppDemo({
  completed,
  onComplete,
  onNext,
  step
}: {
  completed: boolean;
  onComplete: () => void;
  onNext: () => void;
  step: DemoStep;
}) {
  const { t } = useI18n();

  if (step === 0) {
    return (
      <ResourceSetup
        action={t("portal.home.demo.app.openCreate")}
        icon={<AppWindow aria-hidden="true" />}
        location={t("portal.home.demo.location.portalApps")}
        onNext={onNext}
        interactive
        permissionDefaults={["portfolio-advisory", "authorized-clients"]}
        permissionGroups={[
          {
            children: [
              {
                children: [
                  { label: t("portal.home.demo.app.permission.portfolioAdvisory"), value: "portfolio-advisory" },
                  { label: t("portal.home.demo.app.permission.investmentOperations"), value: "investment-operations" }
                ],
                label: t("portal.home.demo.app.permission.investmentManagement")
              },
              {
                children: [{ label: t("portal.home.demo.app.permission.authorizedClients"), value: "authorized-clients" }],
                label: t("portal.home.demo.app.permission.hongKongAdvisory")
              }
            ],
            label: t("portal.home.demo.app.permission.privateBank")
          },
          {
            children: [
              { label: t("portal.home.demo.app.permission.riskLimits"), value: "risk-limits" },
              { label: t("portal.home.demo.app.permission.complianceData"), value: "compliance-data" }
            ],
            label: t("portal.home.demo.app.permission.riskCompliance")
          },
          {
            children: [
              { label: t("portal.home.demo.app.permission.authorizedPortfolioData"), value: "authorized-portfolio-data" },
              { label: t("portal.home.demo.app.permission.aggregatedData"), value: "aggregated-data" }
            ],
            label: t("portal.home.demo.app.permission.dataScope")
          }
        ]}
        rows={[
          [t("portal.home.demo.cloudResources"), t("portal.home.demo.app.cloudResources")],
          [t("portal.home.demo.type"), t("apps.create.appType.web.label")],
          [t("portal.home.demo.permissions"), t("portal.home.demo.app.permissions")]
        ]}
        typeOptions={[
          t("apps.create.appType.static.label"),
          t("apps.create.appType.web.label"),
          t("apps.create.appType.agent.label"),
          t("apps.create.appType.automation.label")
        ]}
        title={t("portal.home.demo.app.setupTitle")}
      />
    );
  }

  if (step === 1) {
    return (
      <AgentHandoff
        action={t("portal.home.demo.app.openPreview")}
        code={t("portal.home.demo.app.handoffCode")}
        eyebrow={t("portal.home.demo.app.handoffEyebrow")}
        location={t("portal.home.demo.location.portalAgent")}
        onNext={onNext}
        statusItems={[
          t("portal.home.demo.app.agentStatusResource"),
          t("portal.home.demo.app.agentStatusAccess"),
          t("portal.home.demo.app.agentStatusBuild")
        ]}
        title={t("portal.home.demo.app.handoffTitle")}
      />
    );
  }

  return (
    <div className="portal-home-demo-workspace app-preview portfolio-analysis">
      <header>
        <AppWindow aria-hidden="true" />
        <div><small>{t("portal.home.demo.app.preview")}</small><strong>{t("portal.home.demo.app.name")}</strong></div>
        <DemoLocation label={t("portal.home.demo.location.agentMcp")} />
        <span><ShieldCheck aria-hidden="true" size={12} />{t("portal.home.demo.app.ready")}</span>
      </header>
      <div className="portal-home-demo-portfolio-content">
        <div className="portal-home-demo-portfolio-kpis">
          <span><small>{t("portal.home.demo.app.metric.valueLabel")}</small><strong>{t("portal.home.demo.app.metric.value")}</strong></span>
          <span><small>{t("portal.home.demo.app.metric.returnLabel")}</small><strong>{t("portal.home.demo.app.metric.return")}</strong></span>
          <span><small>{t("portal.home.demo.app.metric.riskLabel")}</small><strong>{t("portal.home.demo.app.metric.risk")}</strong></span>
        </div>
        <div className="portal-home-demo-portfolio-charts">
          <article aria-label={t("portal.home.demo.app.chart.performanceTitle")} className="portal-home-demo-chart-card">
            <header><small>{t("portal.home.demo.app.chart.performanceTitle")}</small><strong>{t("portal.home.demo.app.chart.performanceValue")}</strong></header>
            <div className="portal-home-demo-performance-chart" role="img" aria-label={t("portal.home.demo.app.chart.performanceAria")}>
              {[42, 49, 46, 59, 55, 68, 74, 87].map((height, index) => (
                <i key={index} style={{ height: `${height}%` }} />
              ))}
            </div>
          </article>
          <article aria-label={t("portal.home.demo.app.chart.allocationTitle")} className="portal-home-demo-chart-card">
            <header><small>{t("portal.home.demo.app.chart.allocationTitle")}</small><strong>{t("portal.home.demo.app.chart.allocationValue")}</strong></header>
            <div className="portal-home-demo-allocation-chart" role="img" aria-label={t("portal.home.demo.app.chart.allocationAria")}>
              {[
                [t("portal.home.demo.app.chart.equities"), "48%"],
                [t("portal.home.demo.app.chart.fixedIncome"), "32%"],
                [t("portal.home.demo.app.chart.alternatives"), "20%"]
              ].map(([label, value]) => (
                <span key={label}><small>{label}</small><i><b style={{ width: value }} /></i><em>{value}</em></span>
              ))}
            </div>
          </article>
        </div>
        <div className="portal-home-demo-permission-line">
          <LockKeyhole aria-hidden="true" size={13} />
          {t("portal.home.demo.app.previewPermissions")}
        </div>
      </div>
      <button className={completed ? "portal-home-demo-agent-prompt complete" : "portal-home-demo-agent-prompt"} onClick={onComplete} type="button">
        <span className="portal-home-demo-agent-prompt-label"><Bot aria-hidden="true" size={15} />Agent</span>
        <strong>{t(completed ? "portal.home.demo.app.published" : "portal.home.demo.app.publish")}</strong>
        {completed ? <Check aria-hidden="true" size={15} /> : <ArrowRight aria-hidden="true" size={15} />}
      </button>
    </div>
  );
}

export function SkillDemo({
  completed,
  onComplete,
  onNext,
  step
}: {
  completed: boolean;
  onComplete: () => void;
  onNext: () => void;
  step: DemoStep;
}) {
  const { t } = useI18n();

  if (step === 0) {
    return <SkillCreateDemo onNext={onNext} />;
  }

  if (step === 1) {
    return (
      <div className="portal-home-demo-workspace skill-download">
        <div className="portal-home-demo-skill-mark"><TableProperties aria-hidden="true" /></div>
        <div className="portal-home-demo-copy">
          <small>{t("portal.home.demo.skill.catalog")}</small>
          <strong>{t("portal.home.demo.skill.name")}</strong>
          <span>{t("portal.home.demo.skill.description")}</span>
          <span><LockKeyhole aria-hidden="true" size={13} />{t("portal.home.demo.skill.dataBoundary")}</span>
        </div>
        <span className="portal-home-demo-approved"><Check aria-hidden="true" size={13} />{t("portal.home.demo.skill.approved")}</span>
        <button className="portal-home-demo-primary" onClick={onNext} type="button">
          <Copy aria-hidden="true" size={15} />
          {t("portal.home.demo.skill.installInAgent")}
        </button>
      </div>
    );
  }

  return (
    <div className="portal-home-demo-workspace skill-share skill-use">
      <header>
        <FileCheck2 aria-hidden="true" />
        <div><small>{t("portal.home.demo.skill.runComplete")}</small><strong>{t("portal.home.demo.skill.resultTitle")}</strong></div>
      </header>
      <div className="portal-home-demo-metrics">
        <span><strong>1,284</strong><small>{t("portal.home.demo.skill.matched")}</small></span>
        <span><strong>17</strong><small>{t("portal.home.demo.skill.exceptions")}</small></span>
        <span><strong>3</strong><small>{t("portal.home.demo.skill.duplicates")}</small></span>
      </div>
      <div className="portal-home-demo-audience">
        <small>{t("portal.home.demo.skill.usedIn")}</small>
        <strong><Users aria-hidden="true" size={15} />{t("portal.home.demo.skill.agent")}</strong>
      </div>
      <button className={completed ? "portal-home-demo-primary complete" : "portal-home-demo-primary"} onClick={onComplete} type="button">
        {completed ? <Check aria-hidden="true" size={15} /> : <Share2 aria-hidden="true" size={15} />}
        {t(completed ? "portal.home.demo.skill.used" : "portal.home.demo.skill.use")}
      </button>
    </div>
  );
}

function SkillCreateDemo({ onNext }: { onNext: () => void }) {
  const { t } = useI18n();
  const structureKeys = [
    "portal.home.demo.skill.structureInput",
    "portal.home.demo.skill.structureSteps",
    "portal.home.demo.skill.structureChecks",
    "portal.home.demo.skill.structureOutput"
  ] as const;
  const structureItems = structureKeys.map((key) => t(key));
  const downloadHref = `data:text/markdown;charset=utf-8,${encodeURIComponent(`# ${t("portal.home.demo.skill.name")}\n\n${structureItems.map((item) => `- ${item}`).join("\n")}\n`)}`;

  return (
    <div className="portal-home-demo-workspace skill-create">
      <div className="portal-home-demo-skill-conversation">
        <div className="portal-home-demo-skill-message user">
          <small>{t("portal.home.demo.skill.tellAgent")}</small>
          <strong>{t("portal.home.demo.skill.createPrompt")}</strong>
        </div>
        <div className="portal-home-demo-skill-message agent">
          <small>{t("portal.home.demo.location.agent")}</small>
          <strong>{t("portal.home.demo.skill.structureTitle")}</strong>
          <span>{t("portal.home.demo.skill.draftDescription")}</span>
        </div>
      </div>
      <div className="portal-home-demo-skill-draft">
        <span className="portal-home-demo-skill-mark"><Sparkles aria-hidden="true" /></span>
        <div className="portal-home-demo-copy">
          <small>{t("portal.home.demo.skill.draftEyebrow")}</small>
          <strong>{t("portal.home.demo.skill.name")}</strong>
          <div className="portal-home-demo-skill-structure">
            {structureItems.map((item) => <span key={item}>{item}</span>)}
          </div>
        </div>
        <div className="portal-home-demo-skill-draft-actions">
          <span className="portal-home-demo-approved"><Check aria-hidden="true" size={13} />{t("portal.home.demo.skill.draftReady")}</span>
          <a className="portal-home-demo-skill-download" download="portfolio-holdings-reconciliation.skill.md" href={downloadHref}>
            <Download aria-hidden="true" size={13} />
            {t("portal.home.demo.skill.downloadSkill")}
          </a>
        </div>
      </div>
      <button className="portal-home-demo-primary" onClick={onNext} type="button">
        <ArrowRight aria-hidden="true" size={15} />
        {t("portal.home.demo.skill.continueToSearch")}
      </button>
    </div>
  );
}

function DemoLocation({ label }: { label: string }) {
  return <span className="portal-home-demo-location">{label}</span>;
}

type ResourcePermissionNode = {
  children?: ResourcePermissionNode[];
  label: string;
  value?: string;
};

function permissionNodeHasSelection(
  node: ResourcePermissionNode,
  selected: string[],
  path: string[] = []
): boolean {
  const nextPath = [...path, node.label];
  if (node.children?.length) {
    return node.children.some((child) => permissionNodeHasSelection(child, selected, nextPath));
  }
  return selected.includes(node.value ?? nextPath.join("/"));
}

function ResourcePermissionPreview({
  node,
  path,
  selected,
  onToggle
}: {
  node: ResourcePermissionNode;
  path: string[];
  selected: string[];
  onToggle?: (value: string) => void;
}) {
  const nextPath = [...path, node.label];
  const value = node.value ?? nextPath.join("/");
  if (node.children?.length) {
    return (
      <li className="portal-home-demo-permission-branch">
        <details open={permissionNodeHasSelection(node, selected, path)}>
        <summary>{node.label}</summary>
        <ul>
          {node.children.map((child) => (
            <ResourcePermissionPreview key={`${value}/${child.label}`} node={child} path={nextPath} selected={selected} onToggle={onToggle} />
          ))}
        </ul>
        </details>
      </li>
    );
  }

  return (
    <li className={`portal-home-demo-permission-option ${selected.includes(value) ? "selected" : ""}`}>
      <label><input type="checkbox" checked={selected.includes(value)} onChange={() => onToggle?.(value)} /> {node.label}</label>
    </li>
  );
}

function ResourceSetup({
  action,
  icon,
  interactive = false,
  location,
  onNext,
  permissionDefaults = [],
  permissionGroups = [],
  rows,
  typeOptions = [],
  title
}: {
  action: string;
  icon: ReactNode;
  interactive?: boolean;
  location: string;
  onNext: () => void;
  permissionDefaults?: string[];
  permissionGroups?: ResourcePermissionNode[];
  rows: Array<[string, string]>;
  typeOptions?: string[];
  title: string;
}) {
  const { t } = useI18n();
  const cloudResourceOptions = rows[0]?.[1].split(" · ") ?? [];
  const typeLabel = rows[1]?.[0] ?? "Type";
  const [selectedType, setSelectedType] = useState(rows[1]?.[1] ?? typeOptions[0] ?? "");
  const [permissions, setPermissions] = useState(permissionDefaults);
  const [resources, setResources] = useState(cloudResourceOptions.slice(0, 3));
  const permissionLabel = rows[2]?.[0] ?? "Permission scope";
  function togglePermission(value: string) {
    setPermissions((previous) => previous.includes(value) ? previous.filter((item) => item !== value) : [...previous, value]);
  }

  return (
    <div className="portal-home-demo-workspace resource-setup">
      <header>
        <span>{icon}</span>
        <div>
          <small className="portal-home-demo-location">{location}</small>
          <strong>{title}</strong>
        </div>
      </header>
      <div className={`portal-home-demo-resource-fields${interactive ? " interactive" : ""}`}>
        {interactive ? (
          <section className="portal-home-demo-resource-field resource-options">
            <small>{rows[0]?.[0]}</small>
            <ul>
              {cloudResourceOptions.map((resource) => (
                <li className={resources.includes(resource) ? "selected" : ""} key={resource}>
                  <label>
                    <input
                      type="checkbox"
                      checked={resources.includes(resource)}
                      disabled={!resources.includes(resource) && resources.length >= 3}
                      onChange={() => setResources((previous) => previous.includes(resource) ? previous.filter((item) => item !== resource) : [...previous, resource])}
                    />
                    <strong>{resource}</strong>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <div className="portal-home-demo-resource-field" key={rows[0]?.[0]}>
            <small>{rows[0]?.[0]}</small>
            <strong>{rows[0]?.[1]}</strong>
          </div>
        )}
        {interactive ? (
          <>
            <ArrowRight aria-hidden="true" className="portal-home-demo-resource-flow-arrow" size={16} />
            <section className="portal-home-demo-resource-field resource-type-list" key={typeLabel}>
              <small>{typeLabel}</small>
              <ul>
                {typeOptions.map((option) => (
                  <li className={option === selectedType ? "selected" : ""} key={option}>
                    <label><input type="radio" name="learning-app-type" checked={option === selectedType} onChange={() => setSelectedType(option)} /> <strong>{option}</strong></label>
                  </li>
                ))}
              </ul>
            </section>
            <ArrowRight aria-hidden="true" className="portal-home-demo-resource-flow-arrow" size={16} />
            <section className="portal-home-demo-resource-field resource-permissions">
              <header>
                <small>{permissionLabel}</small>
                <strong>{t("portal.home.demo.app.permissionsSelected", { count: permissions.length })}</strong>
              </header>
              <ul className="portal-home-demo-permission-tree">
                {permissionGroups.map((node) => (
                  <ResourcePermissionPreview key={node.label} node={node} path={[]} selected={permissions} onToggle={togglePermission} />
                ))}
              </ul>
            </section>
          </>
        ) : rows.slice(1).map(([label, value]) => (
          <div className="portal-home-demo-resource-field" key={label}>
            <small>{label}</small>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <button className="portal-home-demo-primary" onClick={onNext} type="button">
        <ArrowRight aria-hidden="true" size={15} />
        {action}
      </button>
    </div>
  );
}

function AgentHandoff({
  action,
  code,
  eyebrow,
  location,
  onNext,
  statusItems,
  title
}: {
  action: string;
  code: string;
  eyebrow: string;
  location: string;
  onNext: () => void;
  statusItems: string[];
  title: string;
}) {
  const { t } = useI18n();

  return (
    <div className="portal-home-demo-workspace agent-handoff">
      <div className="portal-home-demo-handoff-card">
        <div className="portal-home-demo-handoff-title">
          <Bot aria-hidden="true" />
          <div><small>{eyebrow} · {location}</small><strong>{title}</strong></div>
        </div>
        <div className="portal-home-demo-code"><FileText aria-hidden="true" size={15} /><code>{code}</code><Check aria-hidden="true" size={14} /></div>
      </div>
      <div className="portal-home-demo-agent-status">
        <small>{t("portal.home.demo.agentWorking")}</small>
        <ul>
          {statusItems.map((item) => <li key={item}><Check aria-hidden="true" size={12} />{item}</li>)}
        </ul>
        <button className="portal-home-demo-primary" onClick={onNext} type="button">
          {action}<ArrowRight aria-hidden="true" size={15} />
        </button>
      </div>
    </div>
  );
}
