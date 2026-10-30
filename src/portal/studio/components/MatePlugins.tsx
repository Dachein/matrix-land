import { FeedbackNotice } from "../../components/FeedbackNotice";
import { useEffect, useId, useRef, useState } from 'react';
import type { PortalCatalog } from '../../../shared/types';
import { Button } from '../../components/Button';
import { appsApiFetch } from '../apiClient';
import './matePlugins.css';

type Skill = { skillId: string; name: string; version: string; canUninstall: boolean };
type Review = { activeReleaseId: string; draftRevision: number; skills: Skill[]; hasUnpublishedChanges?: boolean };
type Connection = { id: string; name: string; status: string; enabledForMate: boolean; lastTestedAt?: string; lastErrorCode?: string; toolCount: number };
type PluginTab = 'skill' | 'mcp';
async function remote<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/auth/remote-mcp/${path}`, { credentials: 'same-origin', cache: 'no-store',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error || 'remote_mcp_failed');
  return result;
}
export function MatePlugins({ catalog, mateId, zh, showTitle = true, onChanged }: {
  catalog: PortalCatalog; mateId: string; zh: boolean; showTitle?: boolean; onChanged?: () => void;
}) {
  const tr = (cn: string, en: string) => zh ? cn : en;
  const [review, setReview] = useState<Review>();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [removal, setRemoval] = useState<{ kind: 'skill' | 'mcp'; id: string; name: string }>();
  const [activeTab, setActiveTab] = useState<PluginTab>('skill');
  const tabId = useId();
  const tabRefs = useRef<Partial<Record<PluginTab, HTMLButtonElement | null>>>({});
  const revision = useRef(0);
  function selectTab(tab: PluginTab) {
    if (tab === activeTab) return;
    setActiveTab(tab);
    setRemoval(undefined);
    setNotice('');
  }
  async function refresh() {
    const ticket = ++revision.current;
    const results = await Promise.allSettled([
      appsApiFetch<Review>(`/mates/${encodeURIComponent(mateId)}/plugins`, catalog),
      remote<{ connections: Connection[]; available: boolean }>(`connections?mateId=${encodeURIComponent(mateId)}`)
    ]);
    if (revision.current !== ticket) return;
    if (results[0].status === 'fulfilled') setReview(results[0].value);
    else throw results[0].reason;
    if (results[1].status === 'fulfilled') { setConnections(results[1].value.connections); setAvailable(results[1].value.available); }
    else { setConnections([]); setAvailable(false); setError(tr('MCP 状态暂时无法读取，请刷新重试。', 'MCP status is unavailable. Refresh to retry.')); }
  }
  async function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'plugin_operation_failed'); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    void run(refresh);
    const focus = () => { void run(refresh); };
    window.addEventListener('focus', focus);
    return () => { revision.current++; window.removeEventListener('focus', focus); };
  }, [mateId, catalog]);
  return <section className="appsCreateSelectPanel mate-plugins" aria-label={tr('插件', 'Plugins')}>
    <div className="appsCreateSelectPanelHeader mate-plugins-heading"><div>{showTitle && <h3>{tr('插件', 'Plugins')}</h3>}<p>{tr('由 Mate 在对话中安装和调试。只有 Owner 可以管理。', 'Mate installs and tests plugins in chat. Only the Owner can manage them.')}</p></div><Button type="button" size="compact" disabled={busy} variant="secondary" onClick={() => void run(refresh)}>{tr('刷新', 'Refresh')}</Button></div>
    {busy && <p role="status">{tr('正在读取插件…', 'Loading plugins…')}</p>}
    {error && <FeedbackNotice tone="error">{error}</FeedbackNotice>}{notice && <p role="status">{notice}</p>}
    <div className="mate-plugin-tabs" role="tablist" aria-label={tr('插件类型', 'Plugin type')}>
      {(['skill', 'mcp'] as const).map(tab => <button
        type="button" role="tab" key={tab} id={`${tabId}-${tab}-tab`}
        aria-controls={`${tabId}-${tab}-panel`} aria-selected={activeTab === tab}
        tabIndex={activeTab === tab ? 0 : -1}
        ref={element => { tabRefs.current[tab] = element; }}
        onClick={() => selectTab(tab)}
        onKeyDown={event => {
          let next: PluginTab;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') next = tab === 'skill' ? 'mcp' : 'skill';
          else if (event.key === 'Home') next = 'skill';
          else if (event.key === 'End') next = 'mcp';
          else return;
          event.preventDefault();
          selectTab(next);
          tabRefs.current[next]?.focus();
        }}
      >{tab === 'skill' ? 'Skill' : 'MCP'} <span className="mate-plugin-tab-count">{tab === 'skill' ? review?.skills.length ?? 0 : connections.length}</span></button>)}
    </div>
    <div className="mate-plugin-panel" role="tabpanel" id={`${tabId}-skill-panel`} aria-labelledby={`${tabId}-skill-tab`} hidden={activeTab !== 'skill'} tabIndex={0}>
    {review?.hasUnpublishedChanges && <p role="status">{tr('有尚未发布的配置修改，请先处理这些修改再变更 Skill。', 'There are unpublished settings. Resolve them before changing Skills.')}</p>}
    {!busy && !review?.skills.length && <p>{tr('尚未安装 Skill。可以在对话中上传 Skill 内容或指定 Workspace Skill。', 'No Skills installed. Provide Skill content or a Workspace Skill in chat.')}</p>}
    {review?.skills.map(skill => <div className="mate-plugin-row" key={skill.skillId}><div><strong>{skill.name}</strong><small>{tr('已安装', 'Installed')} · {skill.version}</small></div>{skill.canUninstall && <Button type="button" disabled={busy || review.hasUnpublishedChanges} variant="secondary" onClick={() => setRemoval({ kind: 'skill', id: skill.skillId, name: skill.name })}>{tr('卸载', 'Uninstall')}</Button>}</div>)}
    <p className="mate-plugins-hint">{tr('自带能力由平台管理。卸载只移除当前 Mate 的 Skill，不删除原始 Skill 包。', 'Built-in capabilities are managed by the platform. Uninstalling preserves the source package.')}</p>
    </div>
    <div className="mate-plugin-panel" role="tabpanel" id={`${tabId}-mcp-panel`} aria-labelledby={`${tabId}-mcp-tab`} hidden={activeTab !== 'mcp'} tabIndex={0}>
    {!available && <p>{tr('在线 MCP 尚未启用。启用后可在对话中连接服务。', 'Online MCP is not enabled yet.')}</p>}
    {available && !busy && !connections.length && <p>{tr('尚未安装 MCP。把服务名称或在线 MCP 地址告诉 Mate。', 'No MCPs installed. Tell Mate the service name or online MCP URL.')}</p>}
    {connections.map(connection => <div className="mate-plugin-row" key={connection.id}><div><strong>{connection.name}</strong><small>{connection.status === 'connected' ? connection.enabledForMate ? tr('已启用', 'Enabled') : tr('已授权 · 等待 Mate 调试或启用', 'Authorized · awaiting Mate test or enablement') : connection.status === 'needs_reauth' ? tr('需要重新授权', 'Authorization expired') : connection.status === 'connecting' ? tr('等待授权', 'Awaiting authorization') : tr('未授权', 'Not authorized')}</small>
      {connection.lastTestedAt && <small>{connection.lastErrorCode ? tr('调试未通过', 'Test failed') : tr(`连接测试通过 · ${connection.toolCount} 个工具`, `Connection tested · ${connection.toolCount} tools`)} · {connection.lastTestedAt}</small>}
      {connection.lastErrorCode && <small>{connection.lastErrorCode}</small>}</div><div className="mate-plugin-actions">
      {available && connection.status !== 'connected' && <Button type="button" disabled={busy} variant="secondary" onClick={() => void run(async () => {
        const result = await remote<{ authorizationUrl?: string }>(`connections/${connection.id}/connect`, { mateId });
        if (result.authorizationUrl) window.location.assign(result.authorizationUrl); else await refresh();
      })}>{tr('授权', 'Authorize')}</Button>}
      <Button type="button" disabled={busy} variant="secondary" onClick={() => setRemoval({ kind: 'mcp', id: connection.id, name: connection.name })}>{tr('移除', 'Remove')}</Button>
    </div></div>)}
    <p className="mate-plugins-hint">{tr('支持在线 HTTP MCP。账号授权通过网页完成，令牌加密保存在 Workspace Auth。Mate 负责连接调试与工具配置。', 'Online HTTP MCP only. Authorize in your browser; Workspace Auth stores encrypted credentials. Mate tests connections and configures tools.')}</p>
    </div>
    {removal && <div className="mate-plugin-confirm" role="group" aria-label={tr('确认移除插件', 'Confirm removal')}><p>{tr(`确认从当前 Mate 移除「${removal.name}」？`, `Remove “${removal.name}” from this Mate?`)}</p><Button type="button" disabled={busy} variant="secondary" onClick={() => setRemoval(undefined)}>{tr('取消', 'Cancel')}</Button><Button type="button" disabled={busy} variant="primary" onClick={() => void run(async () => {
      if (removal.kind === 'skill') {
        if (!review) return;
        await appsApiFetch(`/mates/${encodeURIComponent(mateId)}/plugins`, catalog, { method: 'POST', body: JSON.stringify({ expectedReleaseId: review.activeReleaseId, expectedDraftRevision: review.draftRevision, removeSkillIds: [removal.id] }) });
        onChanged?.();
      } else await remote(`connections/${removal.id}/remove`, { mateId });
      setRemoval(undefined); setNotice(tr('已移除。新的对话回合会使用最新插件配置。', 'Removed. The next conversation turn uses the updated plugins.')); await refresh();
    })}>{tr('确认移除', 'Confirm removal')}</Button></div>}
  </section>;
}
