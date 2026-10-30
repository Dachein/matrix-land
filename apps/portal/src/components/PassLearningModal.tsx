import {
  AppWindow,
  ArrowLeft,
  ArrowRight,
  AtSign,
  BookOpen,
  Bot,
  Check,
  Clock3,
  Database,
  FileText,
  FolderPlus,
  Globe2,
  Mail,
  MessageSquare,
  ShieldCheck,
  Sparkles,
  Users,
  Wrench,
  X
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../../../src/portal/i18n";
import { AppDemo, SkillDemo } from "./PortalHomeOnboardingDemo";
import "../styles/pass-learning.css";

type Scenario = "app" | "knowledge" | "skill" | "mate";
type Progress = { step: number; started: boolean; finished: boolean; demonstrated: boolean };
const initial = (): Progress => ({ step: 0, started: false, finished: false, demonstrated: false });
const scenarioIds: Scenario[] = ["app", "knowledge", "skill", "mate"];
const icons = [AppWindow, BookOpen, Sparkles, Bot];

export function PassLearningModal({ onClose, onConnect }: { onClose: () => void; onConnect: () => void }) {
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
  const copy = zh ? {
    kicker: "WORKSPACE PASS / 常用场景",
    labels: ["创建 App", "知识库", "Skill", "Mate"],
    start: "开始学习", close: "关闭学习引导", next: "下一步",
    finish: "完成学习", explore: "探索其他场景", use: "去使用", connect: "连接我的 AI 助手",
    overview: "场景介绍", demo: "交互演示 · 示例数据",
    knowledgeTitle: "文件即服务，Agent 即界面",
    knowledgeValue: "把团队文件发布成可协作、有权限、可追溯的知识服务。内容由协作者持续维护，用户从自己的 Agent、微信或网页直接访问。",
    mateTitle: "一位 7×24 小时工作的企业 Agent",
    mateValue: "在授权范围内访问公司资源、调用工具，并通过 Web、Agent Call 或邮箱持续接收和执行任务。",
    success: "已完成这个场景", successBody: "接下来，把刚学到的方法用到你的工作中。",
    knowledgeSteps: [
      { title: "创建文件夹", summary: "建立团队文件夹，邀请负责内容维护的同事共同编辑。", detail: "文件夹保留原有结构和版本，协作者可以添加、修改和整理文件，为后续发布知识服务准备可信内容。" },
      { title: "发布知识服务", summary: "把文件夹发布为知识服务，并授权给团队、指定成员或授权客户。", detail: "三种授权对象覆盖内部团队、指定个人和外部授权客户；知识服务沿用清晰的访问边界。" },
      { title: "通过 Agent 更新展示", summary: "直接让 Agent 更新文件，同时保留版本与完整变更日志。", detail: "每次修改都会记录操作者、时间和内容差异，负责人可以随时检查或回看历史版本。" },
      { title: "从熟悉的入口访问", summary: "优先通过你的 Agent 使用知识，也可以选择微信 QClaw 或 Web 访问。", detail: "三个入口访问同一套知识服务，并遵循相同权限；回答会保留原文来源和版本信息。" }
    ],
    mateSteps: [
      { title: "创建 Mate", summary: "定义名字与企业邮箱，获得一位 7×24 小时在线的 AI 同事。" },
      { title: "指定数据权限", summary: "分别授权 App 数据、知识库操作和知识库只读访问。" },
      { title: "配置工具能力", summary: "按工作需要启用网页搜索、文件阅读和文档生成能力。" },
      { title: "从多个入口指派任务", summary: "通过 Web、Agent Call 或企业邮箱提交任务，并持续查看执行进度。" }
    ],
    summaries: {
      app: ["选择应用类型和所需云资源，再明确哪些团队和客户可以访问。", "把资源配置和需求交给 Agent，让它在已有权限范围内开发应用。", "在 Agent 内查看指标与图表，确认效果后再发布给团队。"],
      skill: ["向 Agent 描述工作方法，把输入、步骤、检查项和输出整理成 Skill。", "发现适合任务的 Skill，将它安装到自己的 Agent。", "让 Agent 按 Skill 执行任务，检查结果与异常，再用于实际工作。"]
    }
  } : {
    kicker: "WORKSPACE PASS / COMMON SCENARIOS",
    labels: ["Build an App", "Knowledge", "Skill", "Mate"],
    start: "Start learning", close: "Close learning guide", next: "Next",
    finish: "Finish learning", explore: "Explore other scenarios", use: "Try it", connect: "Connect my AI assistant",
    overview: "Overview", demo: "Interactive demo · Sample data",
    knowledgeTitle: "Files as a service. Agent as the interface.",
    knowledgeValue: "Publish team files as a collaborative, permissioned and traceable knowledge service. Collaborators maintain the content while users access it through their Agent, WeChat or the web.",
    mateTitle: "An enterprise Agent that works 24/7",
    mateValue: "Give an Agent approved access to company resources and tools, then assign work through the web, Agent Call or email.",
    success: "Scenario completed", successBody: "Put what you have learned to work.",
    knowledgeSteps: [
      { title: "Create a folder", summary: "Create a team folder and invite the people responsible for maintaining its content.", detail: "The folder preserves its structure and versions while collaborators add, edit and organize trustworthy source material." },
      { title: "Publish a knowledge service", summary: "Publish the folder and grant access to teams, named members or authorized clients.", detail: "The three audience types cover internal teams, specific people and authorized external clients, with a clear boundary for every answer." },
      { title: "Update the view with Agent", summary: "Ask Agent to update files while keeping versions and a complete change log.", detail: "Each update records who changed what and when, so owners can review differences or return to an earlier version." },
      { title: "Access it from familiar channels", summary: "Use your Agent first, or access the same knowledge through WeChat QClaw or the web.", detail: "All three channels use the same service and permissions, with source and version information attached to answers." }
    ],
    mateSteps: [
      { title: "Create a Mate", summary: "Choose a name and company email for an AI colleague that is available 24/7." },
      { title: "Set data permissions", summary: "Grant App data, Knowledge operations and read-only Knowledge access separately." },
      { title: "Configure tools", summary: "Enable web search, file reading and document generation for the work it needs to do." },
      { title: "Assign work from any channel", summary: "Submit tasks through the web, Agent Call or company email and follow their progress." }
    ],
    summaries: {
      app: ["Choose an application type and cloud resources, then define team and client access.", "Give the resource configuration and requirements to your Agent to develop within the agreed permissions.", "Preview metrics and charts in your Agent, then publish the reviewed result to your team."],
      skill: ["Describe your working method to an Agent: inputs, steps, checks and outputs.", "Discover a Skill for your task and install it in your Agent.", "Run the Skill with your Agent, check the results and exceptions, then apply it to your work."]
    }
  };
  const [selected, setSelected] = useState<Scenario>("app");
  const [progress, setProgress] = useState<Record<Scenario, Progress>>({
    app: initial(), knowledge: initial(), skill: initial(), mate: initial()
  });
  const dialog = useRef<HTMLDialogElement>(null);
  const current = progress[selected];
  const index = scenarioIds.indexOf(selected);
  const titles = [t("portal.home.previewBuilderTitle"), copy.knowledgeTitle, t("portal.home.previewExpenseSkillTitle"), copy.mateTitle];
  const values = [t("portal.home.previewBuilderBody"), copy.knowledgeValue, t("portal.home.previewExpenseSkillBody"), copy.mateValue];
  const steps = selected === "app"
    ? [t("portal.home.demo.app.stepDescribe"), t("portal.home.demo.app.stepHandoff"), t("portal.home.demo.app.stepPublish")]
    : selected === "skill"
      ? [t("portal.home.demo.skill.stepCreate"), t("portal.home.demo.skill.stepInstall"), t("portal.home.demo.skill.stepUse")]
      : selected === "knowledge"
        ? copy.knowledgeSteps.map((step) => step.title)
        : copy.mateSteps.map((step) => step.title);
  const summary = selected === "knowledge"
    ? `${copy.knowledgeSteps[current.step].summary} ${copy.knowledgeSteps[current.step].detail}`
    : selected === "mate" ? copy.mateSteps[current.step].summary : copy.summaries[selected][current.step];

  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    element?.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      element?.close();
      document.body.style.overflow = overflow;
      previousFocus?.focus();
    };
  }, []);

  function update(change: Partial<Progress>) {
    setProgress((previous) => ({ ...previous, [selected]: { ...previous[selected], ...change } }));
  }
  function next() {
    if (current.step < steps.length - 1) update({ step: current.step + 1 });
    else update({ finished: true });
  }
  function explore() {
    setSelected(scenarioIds[(index + 1) % 3]);
  }
  function goUse() {
    onClose();
    window.location.hash = selected === "app" || selected === "mate" ? "/apps" : selected === "knowledge" ? "/knowledge" : "/skills-apps";
  }
  const overview = !current.started;
  return createPortal(
    <dialog className="pass-learning" ref={dialog} aria-label={copy.kicker} onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <header className="pass-learning-header">
        <strong>{copy.kicker}</strong>
        <button className="pass-learning-close" aria-label={copy.close} onClick={onClose} type="button"><X /></button>
      </header>
      <nav className="pass-learning-tabs" aria-label={zh ? "学习场景" : "Learning scenarios"}>
        {scenarioIds.map((id, i) => {
          const TabIcon = icons[i];
          return <button key={id} aria-pressed={selected === id} onClick={() => setSelected(id)} type="button">
            <TabIcon size={22} /><span>{copy.labels[i]}</span>
            {progress[id].finished && <Check size={15} />}
          </button>;
        })}
      </nav>
      <div className="pass-learning-content">
        {overview ? (
          <section className="pass-learning-overview">
            <div className="pass-learning-intro">
              <small>{String(index + 1).padStart(2, "0")} / {copy.labels[index]}</small>
              <h3>{titles[index]}</h3><p>{values[index]}</p>
              <button className="pass-learning-primary" onClick={() => update({ started: true })} type="button">
                {selected === "mate" ? (zh ? "接收任务" : "Accept task") : copy.start}<ArrowRight size={18} />
              </button>
            </div>
            <div className="pass-learning-map">
              {selected === "knowledge" ? <KnowledgeDemo compact step={0} /> :
                selected === "mate" ? <MateDemo compact step={0} /> :
                  <div className="pass-learning-preview" inert>
                    {selected === "app" ? <AppDemo step={2} completed={false} onComplete={() => {}} onNext={() => {}} /> :
                      <SkillDemo step={0} completed={false} onComplete={() => {}} onNext={() => {}} />}
                  </div>}
              <ol className={`pass-learning-roadmap${steps.length === 4 ? " four" : ""}`}>{steps.map((label, i) =>
                <li key={label}><small>STEP {i + 1}</small><strong>{label}</strong>{i < steps.length - 1 && <ArrowRight size={18} />}</li>)}</ol>
            </div>
          </section>
        ) : current.finished ? (
          <section className="pass-learning-complete">
            <span className="pass-learning-mark"><Check size={34} /></span>
            <small>{titles[index]}</small><h3>{copy.success}</h3><p>{copy.successBody}</p>
            <div><button className="pass-learning-primary" onClick={goUse} type="button">{copy.use}<ArrowRight size={18} /></button>
              <button onClick={explore} type="button">{copy.explore}</button></div>
          </section>
        ) : (
          <section className="pass-learning-step">
            <div className="pass-learning-canvas">
              <small className="pass-learning-demo-label">{copy.demo}</small>
              <div className="pass-learning-stage">
                {selected === "app" && <AppDemo step={current.step as 0 | 1 | 2} completed={current.demonstrated} onComplete={() => update({ demonstrated: true })} onNext={next} />}
                {selected === "skill" && <SkillDemo step={current.step as 0 | 1 | 2} completed={current.demonstrated} onComplete={() => update({ demonstrated: true })} onNext={next} />}
                {selected === "knowledge" && <KnowledgeDemo step={current.step} />}
                {selected === "mate" && <MateDemo step={current.step} />}
              </div>
            </div>
            <aside className="pass-learning-story">
              <small>{copy.labels[index]} / STEP {current.step + 1}</small>
              <h3>{steps[current.step]}</h3><p>{summary}</p>
              <button onClick={() => update({ started: false })} type="button"><ArrowLeft size={16} />{copy.overview}</button>
            </aside>
          </section>
        )}
      </div>
      <footer className="pass-learning-footer">
        {!overview && !current.finished ? <>
          <nav aria-label={zh ? "学习步骤" : "Learning steps"}>{steps.map((label, i) =>
            <button key={label} aria-current={current.step === i ? "step" : undefined} onClick={() => update({ step: i })} type="button"><small>STEP {i + 1}</small><span>{label}</span></button>)}</nav>
          <div className="pass-learning-paging">
            <button className="pass-learning-primary" onClick={next} type="button">{current.step === steps.length - 1 ? copy.finish : copy.next}<ArrowRight size={16} /></button>
          </div>
        </> : <><span>{zh ? `${steps.length} 步，从了解开始，到动手使用。` : `${steps.length} steps from understanding to doing.`}</span>
          <button onClick={onConnect} type="button">{copy.connect}<ArrowRight size={16} /></button></>}
      </footer>
    </dialog>, document.body
  );
}

function KnowledgeDemo({ compact = false, step }: { compact?: boolean; step: number }) {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";

  if (step === 0) return <KnowledgeFolderDemo compact={compact} />;

  if (step === 1) {
    const audiences = zh ? ["私人银行团队", "指定成员", "授权客户"] : ["Private Banking team", "Named members", "Authorized clients"];
    return (
      <div className={`pass-learning-ui knowledge-action${compact ? " compact" : ""}`}>
        <header>
          <span><BookOpen aria-hidden="true" /></span>
          <div><small>{zh ? "发布知识服务" : "PUBLISH KNOWLEDGE SERVICE"}</small><strong>{zh ? "私人银行知识中心" : "Private Banking Knowledge Hub"}</strong></div>
          <button type="button">{zh ? "发布" : "Publish"}<ArrowRight aria-hidden="true" /></button>
        </header>
        <div className="pass-learning-knowledge-body">
          <small>{zh ? "允许访问的范围" : "WHO CAN ACCESS"}</small>
          <div className="pass-learning-scope-list">{audiences.map((audience, index) => <span key={audience}><i><Users aria-hidden="true" /></i><strong>{audience}</strong><small>{index === 0 ? (zh ? "整个团队" : "Whole team") : index === 1 ? (zh ? "按成员选择" : "Select people") : (zh ? "仅已授权" : "Approved only")}</small><Check aria-hidden="true" /></span>)}</div>
        </div>
        <footer><ShieldCheck aria-hidden="true" /><span>{zh ? "知识服务只对以上范围开放" : "The service is available only to the audiences above"}</span></footer>
      </div>
    );
  }

  if (step === 2) {
    return (
      <div className={`pass-learning-ui knowledge-action${compact ? " compact" : ""}`}>
        <header>
          <span><Bot aria-hidden="true" /></span>
          <div><small>{zh ? "通过 Agent 更新" : "UPDATE WITH AGENT"}</small><strong>{zh ? "产品资料 / 2026 投资展望" : "Product materials / 2026 outlook"}</strong></div>
          <em>{zh ? "已保存" : "Saved"}</em>
        </header>
        <div className="pass-learning-agent-update">
          <div><small>{zh ? "告诉 Agent" : "TELL AGENT"}</small><strong>{zh ? "把第三季度市场观点更新到展示页，并保留原始版本。" : "Update the page with the Q3 market view and keep the original version."}</strong></div>
          <ArrowRight aria-hidden="true" />
          <div><small>{zh ? "Agent 已完成" : "AGENT COMPLETED"}</small><strong>{zh ? "已更新 3 处内容 · 创建版本 v12" : "3 sections updated · Version v12 created"}</strong></div>
        </div>
        <footer><FileText aria-hidden="true" /><span>{zh ? "变更记录：内容、操作者、时间均可追溯" : "Change log: content, editor and time are traceable"}</span></footer>
      </div>
    );
  }

  const channels = [
    { icon: Bot, label: zh ? "我的 Agent" : "My Agent", note: zh ? "推荐入口" : "Recommended" },
    { icon: MessageSquare, label: zh ? "微信 QClaw" : "WeChat QClaw", note: zh ? "移动访问" : "On mobile" },
    { icon: Globe2, label: "Web", note: zh ? "浏览器访问" : "In browser" }
  ];
  return (
    <div className={`pass-learning-ui knowledge-action${compact ? " compact" : ""}`}>
      <header>
        <span><BookOpen aria-hidden="true" /></span>
        <div><small>{zh ? "访问知识服务" : "ACCESS KNOWLEDGE SERVICE"}</small><strong>{zh ? "选择你熟悉的入口" : "Choose a familiar channel"}</strong></div>
      </header>
      <div className="pass-learning-channel-list">{channels.map(({ icon: ChannelIcon, label, note }) => <article key={label}><span><ChannelIcon aria-hidden="true" /></span><strong>{label}</strong><small>{note}</small><ArrowRight aria-hidden="true" /></article>)}</div>
      <footer><ShieldCheck aria-hidden="true" /><span>{zh ? "所有入口使用同一权限与来源记录" : "Every channel uses the same permissions and sources"}</span></footer>
    </div>
  );
}

function KnowledgeFolderDemo({ compact = false }: { compact?: boolean }) {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const files = zh
    ? ["CIO 观点", "产品资料", "投资政策"]
    : ["CIO views", "Product materials", "Investment policy"];
  const people = zh ? ["内容负责人", "投资顾问", "合规同事"] : ["Content owner", "Investment adviser", "Compliance"];

  return (
    <div className={`pass-learning-ui knowledge-folder${compact ? " compact" : ""}`}>
      <header>
        <span><FolderPlus aria-hidden="true" /></span>
        <div><small>{zh ? "知识库 / 新建文件夹" : "KNOWLEDGE / NEW FOLDER"}</small><strong>{zh ? "私人银行知识中心" : "Private Banking Knowledge Hub"}</strong></div>
        <button type="button"><Users aria-hidden="true" />{zh ? "邀请协作者" : "Invite collaborators"}</button>
      </header>
      <div className="pass-learning-folder-tree">
        <strong>{zh ? "文件夹内容" : "Folder contents"}</strong>
        {files.map((file, index) => <span key={file}><FileText aria-hidden="true" />{file}<small>{index + 3} {zh ? "个文件" : "files"}</small></span>)}
      </div>
      <aside>
        <small>{zh ? "协作者" : "COLLABORATORS"}</small>
        {people.map((person, index) => <span key={person}><i>{String.fromCharCode(65 + index)}</i><strong>{person}</strong><Check aria-hidden="true" /></span>)}
      </aside>
    </div>
  );
}

function MateDemo({ compact = false, step }: { compact?: boolean; step: number }) {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const content = [
    {
      eyebrow: zh ? "创建 Mate" : "CREATE MATE",
      title: zh ? "Cortana · 投资运营 Mate" : "Cortana · Investment Operations Mate",
      items: [
        { icon: AtSign, label: "ur.botname@mate.example.invalid" },
        { icon: Clock3, label: zh ? "7×24 小时在线" : "Available 24/7" },
        { icon: ShieldCheck, label: zh ? "企业身份已验证" : "Enterprise identity verified" }
      ]
    },
    {
      eyebrow: zh ? "数据权限" : "DATA PERMISSIONS",
      title: zh ? "只访问完成任务所需的数据" : "Access only the data required for the task",
      items: [
        { icon: Database, label: zh ? "App 数据" : "App data" },
        { icon: BookOpen, label: zh ? "知识库操作" : "Knowledge operations" },
        { icon: FileText, label: zh ? "知识库只读" : "Knowledge read-only" }
      ]
    },
    {
      eyebrow: zh ? "工具能力" : "TOOLS",
      title: zh ? "为具体工作配置工具" : "Configure tools for the work",
      items: [
        { icon: Globe2, label: zh ? "搜索网页" : "Search the web" },
        { icon: FileText, label: zh ? "阅读文件" : "Read files" },
        { icon: Wrench, label: zh ? "生成文档" : "Generate documents" }
      ]
    },
    {
      eyebrow: zh ? "任务入口" : "TASK CHANNELS",
      title: zh ? "从熟悉的入口指派任务" : "Assign work from familiar channels",
      items: [
        { icon: Globe2, label: "Web" },
        { icon: MessageSquare, label: "Agent Call" },
        { icon: Mail, label: zh ? "企业邮箱" : "Company email" }
      ]
    }
  ][step];

  return (
    <div className={`pass-learning-ui mate${compact ? " compact" : ""}`}>
      <header>
        <span><Bot aria-hidden="true" /></span>
        <div><small>{content.eyebrow}</small><strong>{content.title}</strong></div>
        <em><i />{zh ? "在线" : "Online"}</em>
      </header>
      <div className="pass-learning-mate-flow">
        {content.items.map(({ icon: ItemIcon, label }, index) => (
          <article key={label}>
            <span><ItemIcon aria-hidden="true" /></span>
            <strong>{label}</strong>
            <small>{String(index + 1).padStart(2, "0")}</small>
            <Check aria-hidden="true" />
          </article>
        ))}
      </div>
      <footer>
        <Bot aria-hidden="true" />
        <div><small>{zh ? "任务状态" : "TASK STATUS"}</small><strong>{zh ? "已准备好接收下一项任务" : "Ready for the next task"}</strong></div>
        <ArrowRight aria-hidden="true" />
      </footer>
    </div>
  );
}
