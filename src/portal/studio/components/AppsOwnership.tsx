import { FeedbackNotice } from "../../components/FeedbackNotice";
import { useEffect, useState } from 'react';
import { ArrowRightLeft, X } from 'lucide-react';
import type { AppsOwnershipAsset, AppsOwnerTransfer } from '../../../shared/appsOwnership';
import type { PortalCatalog } from '../../../shared/types';
import { Button } from '../../components/Button';
import { FormField, TextArea, TextInput } from '../../components/FormField';
import { ModalShell } from '../../components/ModalShell';
import { PeopleMentionPicker } from '../../components/PeopleMentionPicker';
import { usePeopleDirectory } from '../../hooks/usePeopleDirectory';
import { useOwnershipI18n } from '../../i18n/useOwnershipI18n';
import { AppsApiError, appsApiFetch } from '../apiClient';
import { isCurrentAppsOwner } from '../productDetailModels';
import '../../../../apps/portal/src/styles/apps-ownership.css';

const notify = () => window.dispatchEvent(new Event('workspace:apps-ownership-changed'));

function useOwnershipError() {
  const { t } = useOwnershipI18n();
  return (error: unknown) => {
    if (error instanceof AppsApiError) {
      if (error.code === 'apps_owner_target_inactive') return t('apps.ownership.inactive');
      if (error.code === 'apps_owner_transfer_already_pending') return t('apps.ownership.alreadyPending');
      if (error.code === 'apps_ownership_sync_pending') return t('apps.ownership.syncPending');
      if (['apps_owner_transfer_not_pending', 'apps_owner_transfer_owner_changed', 'apps_owner_transfer_expired'].includes(error.code) || error.status === 409) return t('apps.ownership.conflict');
      if (error.status === 403) return t('apps.ownership.denied');
    }
    return t('apps.ownership.failed');
  };
}

export function AppsOwnershipSettings({ catalog, asset }: { catalog: PortalCatalog; asset: Pick<AppsOwnershipAsset, 'id' | 'type' | 'name' | 'ownerUserId'> }) {
  const { t } = useOwnershipI18n();
  const [open, setOpen] = useState(false);
  if (!isCurrentAppsOwner(asset.ownerUserId, catalog.currentUser)) return null;
  return <section className="appsOwnershipSettings">
    <div><strong>{t('knowledge.ownerTransfer')}</strong><p>{t('apps.ownership.ownerHelp')}</p></div>
    <Button iconBefore={<ArrowRightLeft size={16} />} onClick={() => setOpen(true)} size="compact">{t('knowledge.ownerTransfer')}</Button>
    {open && <AppsOwnerTransferDialog catalog={catalog} asset={asset} onClose={() => setOpen(false)} onSaved={() => setOpen(false)} />}
  </section>;
}

export function AppsOwnerTransferDialog({ catalog, asset, admin = false, onClose, onSaved }: {
  catalog: PortalCatalog; asset: Pick<AppsOwnershipAsset, 'id' | 'type' | 'name' | 'ownerUserId'>; admin?: boolean; onClose: () => void; onSaved: (pending: boolean) => void;
}) {
  const { t } = useOwnershipI18n();
  const { people, state } = usePeopleDirectory(catalog, true, true);
  const errorMessage = useOwnershipError();
  const [selected, setSelected] = useState<string[]>([]);
  const [retain, setRetain] = useState(true);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const candidates = people.filter(p => ![p.id, p.email].some(v => v.toLowerCase() === asset.ownerUserId.toLowerCase()));
  const owner = people.find(p => [p.id, p.email].includes(asset.ownerUserId));
  async function save() {
    setBusy(true); setError('');
    try {
      const path = admin ? `/admin/ownership/${asset.type}s/${encodeURIComponent(asset.id)}` : `/${asset.type}s/${encodeURIComponent(asset.id)}/owner-transfer`;
      const result = await appsApiFetch<{ syncPending: boolean }>(path, catalog, { method: 'POST', body: JSON.stringify({ toUserId: selected[0], retainPreviousOwner: retain, reason }) });
      notify();
      onSaved(result.syncPending);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return <ModalShell ariaLabel={t('knowledge.ownerTransfer')} modalClassName="appsOwnershipDialog" headerClassName="appsOwnershipHeader" overlayClassName="appsOwnershipOverlay" onClose={() => { if (!busy) onClose(); }}
    header={<h2>{t('knowledge.ownerTransfer')} · {asset.name}</h2>} headerActions={<Button aria-label={t('common.close')} disabled={busy} onClick={onClose} variant="icon"><X size={18} /></Button>}>
    <div className="appsOwnershipBody">
      <p>{t(admin ? 'apps.ownership.adminHelp' : 'apps.ownership.ownerHelp')}</p>
      <p>{t('apps.ownership.currentOwner')}: <strong>{owner?.name || asset.ownerUserId}</strong></p>
      <FormField label={t('knowledge.ownerTransferTo')}><PeopleMentionPicker ariaLabel={t('knowledge.ownerTransferTo')} candidates={candidates} disabled={busy || state !== 'ready'} onChange={setSelected} selectedIds={selected} removePersonLabel={person => t('apps.collaborators.remove', { label: person.name })} singleSelect placeholder={t('knowledge.collaboratorSearchPlaceholder')} /></FormField>
      {state === 'error' && <FeedbackNotice tone="error">{t('apps.collaborators.directoryError')}</FeedbackNotice>}
      <label className="appsOwnershipRetention"><input type="checkbox" checked={retain} disabled={busy} onChange={e => setRetain(e.target.checked)} />{t('apps.ownership.retain')}</label>
      {admin && <FormField label={t('apps.ownership.reason')}><TextArea value={reason} maxLength={500} disabled={busy} onChange={e => setReason(e.target.value)} /></FormField>}
      {error && <FeedbackNotice tone="error">{error}</FeedbackNotice>}
      <div className="formActions"><Button disabled={busy} onClick={onClose}>{t('apps.editor.cancel')}</Button><Button disabled={busy || selected.length !== 1 || state !== 'ready' || (admin && !reason.trim())} isLoading={busy} onClick={() => void save()}>{t(admin ? 'apps.ownership.transferNow' : 'apps.ownership.send')}</Button></div>
    </div>
  </ModalShell>;
}

export function AppsOwnerTransferInbox({ catalog }: { catalog: PortalCatalog }) {
  const { t } = useOwnershipI18n();
  const errorMessage = useOwnershipError();
  const { people } = usePeopleDirectory(catalog);
  const [transfers, setTransfers] = useState<AppsOwnerTransfer[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    appsApiFetch<{ transfers: AppsOwnerTransfer[] }>('/owner-transfers', catalog).then(p => { if (live) { setTransfers(p.transfers); setError(''); } }).catch(e => { if (live) setError(errorMessage(e)); });
    return () => { live = false; };
  }, [catalog, revision]);
  useEffect(() => {
    const update = () => setRevision(v => v + 1);
    window.addEventListener('workspace:apps-ownership-changed', update);
    return () => window.removeEventListener('workspace:apps-ownership-changed', update);
  }, []);
  async function decide(row: AppsOwnerTransfer, action: 'accept' | 'reject' | 'cancel') {
    setBusy(row.id); setError(''); setNotice('');
    try {
      const result = await appsApiFetch<{ syncPending: boolean }>(`/owner-transfers/${encodeURIComponent(row.id)}/${action}`, catalog, { method: 'POST' });
      setNotice(t(result.syncPending ? 'apps.ownership.syncPending' : action === 'accept' ? 'apps.ownership.completed' : 'apps.ownership.requestClosed'));
      notify();
    } catch (e) { setError(errorMessage(e)); setRevision(v => v + 1); } finally { setBusy(''); }
  }
  const pending = transfers.filter(row => row.status === 'pending');
  if (!pending.length && !notice && !error) return null;
  const name = (id: string) => people.find(p => [p.id, p.email].includes(id))?.name || id;
  return <section className="appsOwnershipInbox" aria-label={t('apps.ownership.requests')}><h2>{t('apps.ownership.requests')}</h2>
    {notice && <p role="status">{notice}</p>}{error && <FeedbackNotice tone="error">{error} <Button size="compact" onClick={() => setRevision(v => v + 1)}>{t('common.refresh')}</Button></FeedbackNotice>}
    {pending.map(row => <div className="appsOwnershipRequest" key={row.id}><div><strong>{row.assetName}</strong><p>{name(row.fromUserId)} → {name(row.toUserId)}</p><small>{t(row.retainPreviousOwner ? 'apps.ownership.retain' : 'apps.ownership.removeOld')} · {t('apps.ownership.expires')}: {new Date(row.expiresAt).toLocaleString()}</small></div><div className="formActions">
      {row.toUserId === catalog.currentUser.id ? <><Button disabled={Boolean(busy)} isLoading={busy === row.id} onClick={() => void decide(row, 'accept')}>{t('apps.ownership.accept')}</Button><Button disabled={Boolean(busy)} onClick={() => void decide(row, 'reject')}>{t('apps.ownership.reject')}</Button></> : <Button disabled={Boolean(busy)} onClick={() => void decide(row, 'cancel')}>{t('common.cancel')}</Button>}
    </div></div>)}
  </section>;
}

export function AppsOwnershipAdmin({ catalog }: { catalog: PortalCatalog }) {
  const { t } = useOwnershipI18n();
  const errorMessage = useOwnershipError();
  const { people } = usePeopleDirectory(catalog);
  const [assets, setAssets] = useState<AppsOwnershipAsset[]>([]);
  const [selected, setSelected] = useState<AppsOwnershipAsset>();
  const [query, setQuery] = useState('');
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (catalog.currentUser.role !== 'admin') return;
    let live = true;
    appsApiFetch<{ assets: AppsOwnershipAsset[] }>('/admin/ownership', catalog).then(p => { if (live) { setAssets(p.assets); setError(''); } }).catch(e => { if (live) setError(errorMessage(e)); });
    return () => { live = false; };
  }, [catalog, revision]);
  if (catalog.currentUser.role !== 'admin') return null;
  const name = (id: string) => people.find(p => [p.id, p.email].includes(id))?.name || id;
  const filtered = assets.filter(a => `${a.name} ${name(a.ownerUserId)} ${a.type}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="portal-admin-panel appsOwnershipAdmin" aria-label={t('apps.ownership.adminTitle')}>
    <header className="portal-admin-panel-heading"><h2>{t('apps.ownership.adminTitle')}</h2><Button size="compact" onClick={() => setRevision(v => v + 1)}>{t('common.refresh')}</Button></header>
    <p>{t('apps.ownership.adminHelp')}</p><TextInput aria-label={t('apps.ownership.searchAssets')} placeholder={t('apps.ownership.searchAssets')} value={query} onChange={e => setQuery(e.target.value)} />
    {error && <FeedbackNotice tone="error">{error}</FeedbackNotice>}{notice && <p role="status">{notice}</p>}
    <div className="portal-admin-table-wrap"><table className="portal-admin-table"><thead><tr><th>{t('admin.assets.columnAsset')}</th><th>{t('apps.ownership.currentOwner')}</th><th>{t('apps.collaborators.title')}</th><th>{t('knowledge.ownerTransfer')}</th></tr></thead><tbody>{filtered.map(a => <tr key={`${a.type}:${a.id}`}><td><strong>{a.name}</strong><small>{a.type === 'app' ? 'App' : 'Skill'}</small></td><td>{name(a.ownerUserId)}</td><td>{a.collaboratorUserIds.map(name).join(', ') || '—'}</td><td>{a.syncPending ? t('apps.ownership.syncPending') : <Button size="compact" aria-label={`${t('knowledge.ownerTransfer')}: ${a.name}`} onClick={() => setSelected(a)}>{t('knowledge.ownerTransfer')}</Button>}</td></tr>)}</tbody></table></div>
    {selected && <AppsOwnerTransferDialog key={selected.id} catalog={catalog} asset={selected} admin onClose={() => setSelected(undefined)} onSaved={pending => { setSelected(undefined); setNotice(t(pending ? 'apps.ownership.syncPending' : 'apps.ownership.completed')); setRevision(v => v + 1); }} />}
  </section>;
}
