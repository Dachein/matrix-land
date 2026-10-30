import { Button, Image, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useContext, useEffect, useRef, useState } from 'react';
import { redirectToLogin } from '../services/api';
import { isAuthRequiredError } from '../services/auth';
import { chatImageDimensions } from '../services/chatImages';
import { openNativeFilePreview } from '../services/fileActions';
import { isPickerCancelled } from '../services/fileSelection';
import { useI18n } from '../services/i18n';
import type { LiveSession } from '../types';

import { ChatContentResize } from './ChatContentResize';
import { workspaceImages as originals, workspaceThumbnails as images } from '../services/workspaceImages';

let nextImageId = 0;

export function ChatImage({ name, url, session, onOpenFile }: {
  name: string; url: string; session?: LiveSession; onOpenFile: () => void;
}) {
  const { t } = useI18n();
  const onContentResize = useContext(ChatContentResize);
  const [elementId] = useState(() => `chat-image-${++nextImageId}`);
  const [nearby, setNearby] = useState(false);
  const [manualLoad, setManualLoad] = useState(false);
  const [path, setPath] = useState('');
  const [failed, setFailed] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const scope = JSON.stringify([url, session?.principalKey || session?.accessToken, session?.mate.id]);
  const previewScope = useRef<string | undefined>(scope);
  previewScope.current = scope;
  useEffect(() => { previewScope.current = scope; setPreviewing(false); return () => { previewScope.current = undefined; }; }, [scope]);
  const [retry, setRetry] = useState(0);
  const [dimensions, setDimensions] = useState(() => chatImageDimensions(0, 0));
  useEffect(() => {
    let alive = true;
    let observer: Taro.IntersectionObserver | undefined;
    Taro.nextTick(() => {
      if (!alive) return;
      try {
        observer = Taro.createIntersectionObserver(Taro.getCurrentInstance().page!, { thresholds: [0, 0.01] });
        observer.relativeTo('.messages', { top: 160, bottom: 160 }).observe(`#${elementId}`, result => {
          if (alive) setNearby((result.intersectionRatio || 0) > 0);
        });
      } catch { /* A manual load button remains available on unsupported clients. */ }
    });
    return () => { alive = false; observer?.disconnect(); };
  }, [elementId]);
  useEffect(() => { setPath(''); setFailed(false); setManualLoad(false); setDimensions(chatImageDimensions(0, 0)); }, [url, session?.principalKey || session?.accessToken, session?.mate.id]);
  useEffect(() => {
    if ((!nearby && !manualLoad) || !session || path) return;
    let alive = true;
    setFailed(false);
    const request = images.acquire(session, url);
    void request.promise.then(path => { if (alive) setPath(path); }).catch(error => {
      if (!alive) return;
      setFailed(true);
      if (isAuthRequiredError(error)) redirectToLogin();
    });
    return () => { alive = false; request.release(); };
  }, [nearby, manualLoad, url, session?.principalKey || session?.accessToken, session?.mate.id, retry, path]);
  // Read intrinsic dimensions once per downloaded thumbnail. H5's image load event
  // reports rendered dimensions, which otherwise shrink again on every lazy remount.
  useEffect(() => {
    if (!path) return;
    let alive = true;
    void Taro.getImageInfo({ src: path }).then(info => {
      if (alive) setDimensions(chatImageDimensions(info.width, info.height));
    }).catch(() => { /* Keep a stable placeholder size if metadata is unavailable. */ });
    return () => { alive = false; };
  }, [path]);
  useEffect(() => { if (!nearby) setManualLoad(false); }, [nearby]);
  useEffect(() => { onContentResize(); }, [path, failed, dimensions.width, dimensions.height, onContentResize]);
  async function preview() {
    if (!session || previewing) return;
    setPreviewing(true);
    try { const original = await originals.load(session, url); if (previewScope.current !== scope) return; await openNativeFilePreview(original, { id: url, name, mimeType: 'image/*' }); }
    catch (error) {
      if (previewScope.current !== scope) return;
      originals.forget(session, url);
      if (isAuthRequiredError(error)) redirectToLogin();
      else if (!isPickerCancelled(error)) await Taro.showToast({ title: t('chat.openFileFailed'), icon: 'none' });
    } finally { if (previewScope.current === scope) setPreviewing(false); }
  }
  return <View id={elementId} className="chat-image-card">
    {!failed && path && (nearby || manualLoad) ? <Image className="chat-image-preview" src={path} mode="aspectFit" lazyLoad
      style={{ width: Taro.pxTransform(dimensions.width), height: Taro.pxTransform(dimensions.height) }}
      onError={() => { if (session) images.forget(session, url); setFailed(true); }}
      onClick={() => void preview()} /> : <View className="chat-image-placeholder" style={{ width: Taro.pxTransform(dimensions.width), height: Taro.pxTransform(dimensions.height) }}>
      <Text>{failed ? t('chat.thumbnailUnavailable') : nearby || manualLoad ? t('chat.imageLoading') : t('chat.imageDeferred')}</Text>
      {!nearby && !manualLoad && !failed && <Button className="chat-image-retry" onClick={() => setManualLoad(true)}>{t('chat.imageLoad')}</Button>}
      {failed && <Button className="chat-image-retry" onClick={() => { if (session) images.forget(session, url); setPath(''); setManualLoad(true); setRetry(value => value + 1); }}>{t('common.retry')}</Button>}
    </View>}
    <Text className="chat-image-name" onClick={onOpenFile}>{name}</Text>
    <Text className="chat-image-hint" onClick={() => void preview()}>{t(previewing ? 'chat.originalLoading' : failed ? 'chat.viewOriginal' : 'chat.imagePreview')}</Text>
  </View>;
}
