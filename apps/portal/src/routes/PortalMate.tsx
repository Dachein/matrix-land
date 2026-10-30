import { FeedbackNotice } from "../../../../src/portal/components/FeedbackNotice";
import { MateConnections } from '../components/mate/MateConnections';
import { isCurrentAppsOwner } from '../../../../src/portal/studio/productDetailModels';
import { ArrowRight, Bot, Check, ChevronLeft, ChevronRight, FolderOpen, LoaderCircle, Plus, ShieldCheck, X } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { Button } from "../../../../src/portal/components/Button";
import { ModalShell } from "../../../../src/portal/components/ModalShell";
import { useI18n } from "../../../../src/portal/i18n";
import { AppsApiError, appsApiFetch } from "../../../../src/portal/studio/apiClient";
import { useAppsWorkspace } from "../../../../src/portal/studio/useAppsWorkspace";
import type { Mate } from "../../../../src/shared/mate";
import { matePetAvatarUrl } from "../../../../src/shared/matePet";
import { MateIntro } from "../components/MateIntro";
import type { PortalCatalog } from "../../../../src/shared/types";
import { PortalRailToggle } from "../components/PortalRailToggle";
import { usePortalRightRail } from "../components/PortalUtilityRail";
import { MateArtifactPreview, type MateArtifact } from "../components/MateArtifactPreview";
import { MateLaunchGate } from "../../../mate-preview/src/MateLaunchGate";
import { MiniappLoginModal } from "../components/MiniappLoginModal";
import "../styles/apps.css";
import "../styles/mate.css";

const MateBuilderModal = lazy(() => import("../../../../src/portal/studio/modals/MateBuilderModal").then((module) => ({ default: module.MateBuilderModal })));
const MateChat = lazy(() => import("../../../mate-preview/src/App").then((module) => ({ default: module.MatePreviewApp })));

type MateModal = "setup" | null;
type MateSetupStage = "name" | "creating" | "success";
type MateRailView = "overview" | "conversations" | "files" | "agents";
const MATE_TEXT = {
  zh: {
    workDescription: "你的工作秘书，处理日常事务。可使用你有权访问的知识与应用。",
    subtitle: "你的工作秘书，可使用你有权访问的知识与应用。",
    loadFailed: "Mate 暂时无法加载，请重试。",
    startFailed: "开启未完成，请重试。已创建的 Mate 会继续设置。",
    emailConflict: "专属邮箱已被占用，请联系管理员核对归属。",
    emailInvalid: "当前邮箱前缀无法使用，请联系管理员。",
    defaultBadge: "默认 Mate",
    continue: "继续开启",
    continuing: "正在完成设置…",
    startTitle: "开启你的 Mate",
    avatarInvalid: "形象地址无效，请重新选择后再试。",
    name: "名字",
    namePlaceholder: "输入昵称",
    start: "开始",
    cancel: "取消",
    settings: "设置",
  },
  en: {
    workDescription: "Your work assistant for everyday tasks, with access to the knowledge and apps you can use.",
    subtitle: "Your default work assistant helps with the knowledge and apps you can access.",
    loadFailed: "Mate could not load. Please retry.",
    startFailed: "Setup did not finish. Retry to continue with the same Mate.",
    emailConflict: "Your reserved Mate email is already in use. Contact an administrator.",
    emailInvalid: "Your account email prefix cannot be used for the Mate address. Contact an administrator.",
    defaultBadge: "Default Mate · cannot be deleted",
    continue: "Continue setup",
    continuing: "Finishing setup…",
    startTitle: "Start your Mate",
    avatarInvalid: "That character could not be loaded. Please choose it again.",
    name: "Name",
    namePlaceholder: "Enter a nickname",
    start: "Start",
    cancel: "Cancel",
    settings: "Settings",
  },
} as const;

export function PortalMate({
  catalog,
  initialConversationId,
  initialArtifactId,
  initialMateId,
  onMateChange,
  onRefresh
}: {
  catalog: PortalCatalog;
  initialConversationId?: string;
  initialArtifactId?: string;
  initialMateId?: string;
  onMateChange?: (mate: Mate) => void;
  onRefresh: () => void;
}) {
  const { locale, setLocale } = useI18n();
  const mateText = (key: keyof typeof MATE_TEXT.zh) => MATE_TEXT[locale === "en" ? "en" : "zh"][key];
  const controller = useAppsWorkspace({ catalog, onCatalogRefresh: onRefresh });
  const [defaultMate, setDefaultMate] = useState<Mate | null>(null);
  const [activeMate, setActiveMate] = useState<Mate | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [modal, setModal] = useState<MateModal>(null);
  const [miniappLoginOpen, setMiniappLoginOpen] = useState(false);
  const [setupStage, setSetupStage] = useState<MateSetupStage>("name");
  const [pluginMate, setPluginMate] = useState<Mate>();
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderLoading, setBuilderLoading] = useState(false);
  const [selected, setSelected] = useState<Mate>();
  const [railView, setRailView] = useState<MateRailView>("overview");
  const rightRail = usePortalRightRail();
  const mobileRailOpen = !rightRail?.collapsed;
  const setMobileRailOpen = (open: boolean) => rightRail?.setCollapsed(!open);
  const [artifact, setArtifact] = useState<MateArtifact | null>(null);
  const [conversationCount, setConversationCount] = useState(0);
  const [sourceCount, setSourceCount] = useState(0);
  const [mailTaskMode, setMailTaskMode] = useState(false);
  const [taskCount, setTaskCount] = useState(0);
  const changeMailTaskMode = (active: boolean) => {
    setMailTaskMode(active);
    if (active && window.matchMedia("(max-width: 760px)").matches) setMobileRailOpen(false);
  };
  const [navigationTarget, setNavigationTarget] = useState<HTMLElement | null>(null);
  const [newConversationTarget, setNewConversationTarget] = useState<HTMLElement | null>(null);
  const [sourcesTarget, setSourcesTarget] = useState<HTMLElement | null>(null);
  const [statusTarget, setStatusTarget] = useState<HTMLElement | null>(null);
  const zh = locale === "zh-CN";

  useEffect(() => {
    let mounted = true;
    void appsApiFetch<{ mate: Mate | null }>("/mates/default", catalog)
      .then(({ mate }) => {
        if (!mounted) return;
        setDefaultMate(mate);
        setActiveMate(mate);
      })
      .catch(() => { if (mounted) setError(mateText("loadFailed")); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [catalog, locale]);

  async function activate() {
    if ((!defaultMate && (!name.trim() || !avatarUrl)) || saving) return;
    setSaving(true);
    setSetupStage("creating");
    setError("");
    try {
      const startedAt = Date.now();
      const payload = await appsApiFetch<{ mate: Mate }>("/mates/default", catalog, {
        method: "POST", body: JSON.stringify({ displayName: name.trim(), avatarUrl })
      });
      const remainingLoadingTime = 700 - (Date.now() - startedAt);
      if (remainingLoadingTime > 0) await new Promise((resolve) => window.setTimeout(resolve, remainingLoadingTime));
      setDefaultMate(payload.mate);
      setActiveMate(payload.mate);
      setSetupStage("success");
    } catch (caught) {
      setSetupStage("name");
      const code = caught instanceof AppsApiError ? caught.code : "";
      setError(code === "default_mate_email_conflict"
        ? mateText("emailConflict")
        : code === "default_mate_user_email_invalid"
          ? mateText("emailInvalid")
          : code === "mate_avatar_invalid" || code === "default_mate_avatar_invalid"
            ? mateText("avatarInvalid")
            : mateText("startFailed"));
    } finally { setSaving(false); }
  }

  function closeSetup() {
    setModal(null);
    setSetupStage("name");
    setName("");
    setError("");
  }

  async function editMate(mate: Mate) {
    if (builderLoading) return;
    setBuilderLoading(true);
    setError("");
    try {
      const detailed = await controller.refreshMate(mate.id);
      if (!detailed?.draftManifest) throw new Error("mate_definition_unavailable");
      setSelected(detailed);
      setBuilderOpen(true);
    } catch {
      setError(mateText("loadFailed"));
    } finally {
      setBuilderLoading(false);
    }
  }

  const mates = [defaultMate, ...controller.mates.filter((mate) => !mate.isDefault && mate.id !== defaultMate?.id && mate.status !== "archived")].filter((mate): mate is Mate => Boolean(mate));
  useEffect(() => {
    if (!initialMateId) return;
    const requestedMate = mates.find((mate) => mate.id === initialMateId);
    if (requestedMate && requestedMate.id !== activeMate?.id) setActiveMate(requestedMate);
  }, [activeMate?.id, initialMateId, mates]);
  if (loading) return <MateLaunchGate locale={locale} minimal />;
  return <div className="portal-workspace-inner portal-mate-workspace">
    <section className="portal-page portal-mate-page" data-mail-task-mode={mailTaskMode} data-rail-view={railView} data-mobile-rail-open={mobileRailOpen}>
      {!defaultMate ? <>
        <MateIntro zh={zh} selectedAvatar={avatarUrl} onSelect={setAvatarUrl} onNext={() => { setSetupStage("name"); setError(""); setModal("setup"); }} onWeixinCreate={() => { setMiniappLoginOpen(true); }} />
      </> : <>
        {railView !== "agents" && <PortalRailToggle label={mobileRailOpen ? (zh ? "收起 Mate 导航" : "Collapse Mate navigation") : (zh ? "打开 Mate 导航" : "Open Mate navigation")} expanded={mobileRailOpen} className="portal-mate-rail-toggle" onToggle={() => setMobileRailOpen(!mobileRailOpen)}><img src={activeMate?.avatarUrl} alt="" />{!mobileRailOpen && <ChevronRight className="portal-mate-rail-toggle-arrow" size={14} aria-hidden="true" />}</PortalRailToggle>}
        <div className="portal-mate-chat-frame" key={`${activeMate?.id ?? ""}:${initialConversationId ?? ""}`}>
          {activeMate?.status === "published" ? <Suspense fallback={<MateLaunchGate locale={locale} avatarUrl={activeMate.avatarUrl} />}><MateChat locale={locale} onLocaleChange={setLocale} welcomeDescription={activeMate.isDefault ? mateText("workDescription") : undefined} avatarUrl={activeMate.avatarUrl} conversationId={initialConversationId} initialWorkspaceFileId={initialArtifactId} mode="live" onPortalFilePreview={(name, load, save, preview) => setArtifact({ name, load, save, preview })} onPortalArtifactChange={(open) => setRailView(open ? "files" : "overview")} onPortalTaskSelect={() => { if (window.matchMedia("(max-width: 760px)").matches) setMobileRailOpen(false); }} portalMailTaskMode={mailTaskMode} portalMateEmail={activeMate.workEmail} onPortalTaskCountChange={setTaskCount} onPortalMailTaskModeChange={changeMailTaskMode} onPortalConversationCountChange={setConversationCount} onPortalSourceCountChange={setSourceCount} portalArtifactOpen={railView === "overview" || railView === "files"} portalNavigationTarget={navigationTarget} portalNewConversationTarget={newConversationTarget} portalSourcesTarget={sourcesTarget} portalStatusTarget={statusTarget} portalSummary={railView === "overview"} presentation="standalone" mateId={activeMate.id} /></Suspense> : <div className="portal-mate-chat-pending"><Bot size={30} /><p>{zh ? "这个 Mate 还未完成开启。" : "This Mate is not ready yet."}</p>{activeMate?.isDefault && <Button disabled={saving} onClick={() => void activate()} variant="primary">{saving ? mateText("continuing") : mateText("continue")}</Button>}<Button disabled={builderLoading} onClick={() => { if (activeMate) void editMate(activeMate); }} variant="secondary">{mateText("settings")}</Button></div>}
        </div>

        <aside aria-label={zh ? "Mate 导航" : "Mate navigation"} className="portal-mate-context-rail portal-context-rail">
          <div className="portal-mate-rail-content">
            <div className="portal-mate-identity">
              <div className="portal-mate-identity-summary"><span className="portal-mate-identity-avatar"><img alt="" src={activeMate?.avatarUrl || matePetAvatarUrl("workspace-bot")} /></span><span className="portal-mate-identity-copy"><strong>{activeMate?.displayName}</strong><small>{activeMate?.isDefault ? mateText("workDescription") : activeMate?.description || activeMate?.jobRole}</small><span className="portal-mate-mode-links"><button className="portal-mate-switch-link" onClick={() => setRailView("agents")} type="button">{zh ? "切换 Mate" : "Switch Mate"} ({mates.length})</button><button aria-pressed={mailTaskMode} className="portal-mate-switch-link" onClick={() => { changeMailTaskMode(!mailTaskMode); setRailView("overview"); setArtifact(null); }} type="button">{zh ? "邮箱与任务" : "Mail & Tasks"} ({taskCount})</button></span></span></div>
            </div>
            <div className="portal-mate-rail-status" ref={setStatusTarget} />
            <div className="portal-mate-new-conversation-slot" ref={setNewConversationTarget} />
            <section className="portal-mate-rail-section portal-mate-rail-conversations">
              {railView === "conversations" && <div className="portal-live-section-header"><button aria-label={zh ? "返回概览" : "Back to overview"} className="portal-mate-rail-back is-labeled" onClick={() => setRailView("overview")} type="button"><ChevronLeft size={17} /><span>{zh ? "返回" : "Back"}</span></button></div>}
              <div className="portal-mate-nav-slot" ref={setNavigationTarget} />
              {railView === "overview" && conversationCount > 5 && <button className="portal-mate-rail-expand" onClick={() => setRailView("conversations")} type="button">{zh ? "展开显示" : "Show all"}</button>}
            </section>
            <section className="portal-mate-rail-section portal-mate-rail-files">
              <div className="portal-live-section-header">{railView === "files" && <button aria-label={zh ? "返回概览" : "Back to overview"} className="portal-mate-rail-back" onClick={() => setRailView("overview")} type="button"><ChevronLeft size={17} /></button>}<h2 className="portal-rail-label">{zh ? "文件" : "Files"}</h2></div>
              <div className="portal-mate-sources-slot" ref={setSourcesTarget}><div className="portal-mate-file-placeholder"><FolderOpen size={20} /><span>{zh ? "当前对话暂无文件" : "No files in this conversation"}</span></div></div>
              {railView === "overview" && sourceCount > 5 && <button className="portal-mate-rail-expand" onClick={() => setRailView("files")} type="button">{zh ? "展开显示" : "Show all"}</button>}
            </section>
            <section className="portal-mate-rail-section portal-mate-rail-agents"><div className="portal-live-section-header"><button aria-label={zh ? "返回概览" : "Back to overview"} className="portal-mate-rail-back" onClick={() => setRailView("overview")} type="button"><ChevronLeft size={17} /></button><h2 className="portal-rail-label">{zh ? "我的 Mate" : "My Mates"}</h2></div><div className="portal-mate-agent-list">{mates.map((mate) => <div className="portal-mate-agent-row" data-selected={activeMate?.id === mate.id} key={mate.id}>
              <button aria-current={activeMate?.id === mate.id ? "page" : undefined} onClick={() => { setMailTaskMode(false); setTaskCount(0); setArtifact(null); setConversationCount(0); setSourceCount(0); setActiveMate(mate); onMateChange?.(mate); setRailView("overview"); setMobileRailOpen(false); }} type="button"><span className="portal-mate-agent-avatar"><img alt="" onError={(event) => { event.currentTarget.src = matePetAvatarUrl("workspace-bot"); }} src={mate.avatarUrl || matePetAvatarUrl("workspace-bot")} /></span><span className="portal-mate-agent-copy"><strong>{mate.displayName}</strong><small>{mate.isDefault ? mateText("defaultBadge") : mate.description || mate.jobRole}</small></span></button>
              <div className="portal-mate-agent-links">
                {isCurrentAppsOwner(mate.ownerUserId, catalog.currentUser) && <><button aria-label={`${zh ? "插件" : "Plugins"} ${mate.displayName}`} onClick={() => setPluginMate(mate)} type="button">{zh ? "插件" : "Plugins"}</button><span aria-hidden="true">｜</span></>}
                <button aria-label={`${mateText("settings")} ${mate.displayName}`} disabled={builderLoading} onClick={() => void editMate(mate)} type="button">{mateText("settings")}</button>
              </div>
            </div>)}</div><Button className="portal-mate-create-button" onClick={() => { setSelected(undefined); setBuilderOpen(true); }} variant="primary"><Plus size={16} />{zh ? "新建 Mate" : "Create Mate"}</Button></section>
          </div>
        </aside>
        {mobileRailOpen && <Button aria-label={zh ? "关闭 Mate 导航" : "Close Mate navigation"} className="portal-mate-mobile-close" onClick={() => setMobileRailOpen(false)} variant="icon"><X size={17} /></Button>}
      </>}
      {pluginMate && isCurrentAppsOwner(pluginMate.ownerUserId, catalog.currentUser) && <MateConnections catalog={catalog} key={`${catalog.currentUser.id}:${pluginMate.id}`} mateId={pluginMate.id} mateName={pluginMate.displayName} zh={zh} onClose={() => setPluginMate(undefined)} />}
      <MateArtifactPreview artifact={artifact} onClose={() => { setArtifact(null); setMobileRailOpen(true); }} />
      {error && !modal && <FeedbackNotice tone="error">{error}</FeedbackNotice>}
      {modal === "setup" && <ModalShell ariaLabel={setupStage === "success" ? (zh ? "Mate 已创建" : "Mate created") : mateText("startTitle")} className={`portal-mate-modal${setupStage === "name" ? " portal-mate-modal-compact" : ""}`} header={setupStage === "success" ? <h2>{zh ? "创建成功" : "Successfully created"}</h2> : undefined} modalClassName="portal-mate-modal" onClose={() => { if (!saving && setupStage !== "success") closeSetup(); }} overlayClassName="portal-mate-modal-overlay">
        {setupStage === "name" && <form className="portal-mate-modal-body portal-mate-setup-name" onSubmit={(event) => { event.preventDefault(); void activate(); }}>
          {avatarUrl && <img className="portal-mate-setup-avatar" alt="" src={avatarUrl} />}
          <label className="portal-mate-setup-field"><span className="portal-mate-visually-hidden">{mateText("name")}</span><input autoComplete="off" autoFocus maxLength={120} onChange={(event) => setName(event.target.value)} placeholder={mateText("namePlaceholder")} value={name} /></label>
          {error && <FeedbackNotice tone="error">{error}</FeedbackNotice>}
          <div className="portal-mate-setup-actions">
            <Button disabled={saving} onClick={closeSetup} variant="secondary">{mateText("cancel")}</Button>
            <Button className="portal-mate-setup-start" disabled={!name.trim() || !avatarUrl || saving} type="submit" variant="primary">{mateText("start")} <ArrowRight size={16} /></Button>
          </div>
        </form>}
        {setupStage === "creating" && <div aria-live="polite" className="portal-mate-modal-body portal-mate-setup-progress" role="status">
          <span className="portal-mate-setup-spinner"><LoaderCircle size={34} /></span>
          <h2>{zh ? "正在创建你的 Mate" : "Creating your Mate"}</h2>
          <p>{zh ? "正在配置专属身份与工作能力…" : "Setting up its identity and work capabilities…"}</p>
        </div>}
        {setupStage === "success" && defaultMate && <div className="portal-mate-modal-body portal-mate-permissions">
          <span className="portal-mate-success-icon"><ShieldCheck size={30} /></span>
          <h2>{zh ? `${defaultMate.displayName} 已准备就绪` : `${defaultMate.displayName} is ready`}</h2>
          <p>{defaultMate.workEmail}</p>
          <h3>{zh ? "已开启的能力" : "Capabilities included"}</h3>
          <ul>
            <li><Check size={16} />{zh ? "查询你有权访问的全部知识库" : "Query every knowledge base you can access"}</li>
            <li><Check size={16} />{zh ? "编辑你有权维护的全部知识库根目录及子目录；写入需确认" : "Edit knowledge roots and subfolders you can maintain, with approval for writes"}</li>
            <li><Check size={16} />{zh ? "使用你有权访问的全部 App MCP" : "Use every App MCP you can access"}</li>
            <li><Check size={16} />{zh ? "公开网页检索与网页读取" : "Public web search and web reading"}</li>
            <li><Check size={16} />{zh ? "文档读取、信息提取与 OCR" : "Document reading, information extraction and OCR"}</li>
            <li><Check size={16} />{zh ? "创建报告、文件与其他成果物" : "Create reports, files and other artifacts"}</li>
            <li><Check size={16} />{zh ? "创建与管理待办、提醒和计划任务" : "Create and manage to-dos, reminders and scheduled tasks"}</li>
            <li><Check size={16} />{zh ? "邮件能力与 Workspace MCP / MCP 连接" : "Email capabilities and Workspace MCP / MCP connections"}</li>
            <li><Check size={16} />{zh ? "在获准范围内调用其他 Mate 协作" : "Call other Mates when permitted"}</li>
          </ul>
          <p className="portal-mate-permission-note">{zh ? "Mate 以当前用户身份执行，每次访问仍按你的实时权限校验。" : "Mate acts as the current user. Each access is checked against your current permissions."}</p>
          <Button onClick={() => setModal(null)} variant="primary">{zh ? "开始使用" : "Start using Mate"} <ArrowRight size={16} /></Button>
        </div>}
      </ModalShell>}
      <MiniappLoginModal onClose={() => setMiniappLoginOpen(false)} open={miniappLoginOpen} zh={zh} />
      {builderOpen && <div className="portal-apps-surface"><Suspense fallback={null}><MateBuilderModal catalog={catalog} onClose={() => { if (!controller.submitting) { setBuilderOpen(false); if (selected?.isDefault) void controller.refreshMate(selected.id).then((updated) => { if (updated) { setDefaultMate(updated); setActiveMate((current) => current?.id === updated.id ? updated : current); } }); } }} onCreate={controller.createMate} onDeployPreview={controller.deployMatePreview} onPublish={controller.publishMate} onSaveDraft={controller.saveMateDraft} onUpdateIdentity={controller.updateMateIdentity} submitting={controller.submitting} mate={selected} /></Suspense></div>}
    </section>
  </div>;
}
