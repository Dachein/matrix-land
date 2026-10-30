import type { LiveSession } from '../types';
import { mateFileReferenceFromUrl } from '../../../../src/shared/mateFileReference.js';

export function chatImageDimensions(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return { width: 400, height: 300 };
  const scale = Math.min(420 / width, 520 / height, 1);
  return { width: Math.max(40, Math.round(width * scale)), height: Math.max(40, Math.round(height * scale)) };
}
export type ChatTextSegment = { type: 'text'; text: string } | { type: 'image'; url: string; name: string };
/** Treat fenced/inline code as literal text; only workspace images become authenticated thumbnails. */
export function chatImageSegments(text: string): ChatTextSegment[] {
  const pattern = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)|!\[([^\]\n]*)\]\((\/api\/workspace-files\/[^)\s]+)\)/g;
  const segments: ChatTextSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match[1]) continue;
    const file = mateFileReferenceFromUrl(match[3], match[2] || '图片');
    if (!file) continue;
    if (match.index! > cursor) segments.push({ type: 'text', text: text.slice(cursor, match.index) });
    segments.push({ type: 'image', url: file.url, name: file.fileName });
    cursor = match.index! + match[0].length;
  }
  if (cursor < text.length) segments.push({ type: 'text', text: text.slice(cursor) });
  return segments;
}

/** Completed bytes use an LRU; queued/in-flight work is deduplicated separately. */
export function createChatImageCache(download: (session: LiveSession, url: string) => Promise<string>, limit = 16) {
  const entries = new Map<string, Promise<string>>();
  type Job = { promise: Promise<string>; start: () => void; cancel: () => void; started: boolean; users: number; pinned: boolean };
  const pending = new Map<string, Job>();
  const waiting: Job[] = [];
  let active = 0;
  const keyFor = (session: LiveSession, url: string) => JSON.stringify([session.principalKey || session.accessToken, session.mate.id, mateFileReferenceFromUrl(url, "image")?.url || url]);
  function get(session: LiveSession, url: string, pinned: boolean) {
    const key = keyFor(session, url);
    const existing = pending.get(key);
    if (existing) { existing.pinned ||= pinned; return { key, job: existing, promise: existing.promise }; }
    const cached = entries.get(key);
    if (cached) { entries.delete(key); entries.set(key, cached); return { key, promise: cached }; }
    let resolve!: (path: string) => void;
    let reject!: (error: unknown) => void;
    const raw = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
    const job: Job = {
      promise: raw.then(path => {
        entries.set(key, job.promise);
        while (entries.size > Math.max(0, limit)) entries.delete(entries.keys().next().value!);
        return path;
      }).finally(() => { if (pending.get(key) === job) pending.delete(key); }),
      started: false, users: 0, pinned,
      start() {
        job.started = true; active++;
        void Promise.resolve().then(() => download(session, url)).then(resolve, reject).finally(() => {
          active--; waiting.shift()?.start();
        });
      },
      cancel() {
        if (job.started || job.pinned || job.users > 0) return;
        const index = waiting.indexOf(job);
        if (index >= 0) waiting.splice(index, 1);
        if (pending.get(key) === job) pending.delete(key);
        reject(new Error('image_load_cancelled'));
      }
    };
    pending.set(key, job);
    if (active < 2) job.start(); else waiting.push(job);
    return { key, job, promise: job.promise };
  }
  return {
    load(session: LiveSession, url: string) { return get(session, url, true).promise; },
    acquire(session: LiveSession, url: string) {
      const { job, promise } = get(session, url, false);
      if (job) job.users++;
      let released = false;
      return { promise, release() {
        if (released || !job) return;
        released = true; job.users--; job.cancel();
      } };
    },
    forget(session: LiveSession, url: string) { entries.delete(keyFor(session, url)); }
  };
}
