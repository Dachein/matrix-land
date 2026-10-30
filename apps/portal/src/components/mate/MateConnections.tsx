import { MatePlugins } from '../../../../../src/portal/studio/components/MatePlugins';
import { ModalShell } from '../../../../../src/portal/components/ModalShell';
import type { PortalCatalog } from '../../../../../src/shared/types';
import { Button } from '../../../../../src/portal/components/Button';
import { X } from 'lucide-react';
import './mateConnections.css';

export function MateConnections({ catalog, mateId, mateName, zh, onClose }: { catalog: PortalCatalog; mateId: string; mateName: string; zh: boolean; onClose: () => void }) {
  return <div className="portal-apps-surface"><ModalShell ariaLabel={`${mateName} · ${zh ? '插件' : 'Plugins'}`} className="appsMcpModal mate-connections-modal" onClose={onClose}
    header={<div><p className="eyebrow">{mateName}</p><h2>{zh ? '插件' : 'Plugins'}</h2></div>} headerActions={<Button type="button" aria-label={zh ? '关闭' : 'Close'} variant="icon" onClick={onClose}><X size={18} /></Button>}>
    <MatePlugins catalog={catalog} mateId={mateId} zh={zh} showTitle={false} />
  </ModalShell></div>;
}
