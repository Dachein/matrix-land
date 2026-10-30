import { documentFileType, filePreviewKind } from './filePreview';
import { mateFileReferenceFromUrl, type MateFileReference } from '../../../../src/shared/mateFileReference.js';
import type { ChatPart } from '../types';

export function fileCardDetails(name: string, mimeType = '', sizeBytes?: number) {
  const extension = name.match(/\.([a-z0-9]{1,12})$/i)?.[1];
  const type = (extension || documentFileType(name, mimeType) || '').toUpperCase();
  let size: string | undefined;
  if (typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) && sizeBytes >= 0) {
    size = sizeBytes < 1024 ? `${Math.round(sizeBytes)} B` : sizeBytes < 1024 * 1024 ? `${(sizeBytes / 1024).toFixed(1)} KB` : `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return { type, size, supported: filePreviewKind(name, mimeType) !== 'unsupported' };
}

/** Use only existing message metadata; drawing a card never starts a file request. */
export function chatFileMetadata(file: MateFileReference, parts: ChatPart[]): { mimeType?: string; sizeBytes?: number } {
  const candidates: Record<string, unknown>[] = [];
  const add = (value: unknown) => { if (value && typeof value === 'object' && !Array.isArray(value)) candidates.push(value as Record<string, unknown>); };
  for (const part of parts) {
    add(part);
    for (const value of [part.output, part.data]) {
      if (!value || typeof value !== 'object') continue;
      const record = value as Record<string, unknown>;
      for (const key of ['file', 'item', 'knowledgeFile']) add(record[key]);
      for (const key of ['items', 'results', 'sources']) if (Array.isArray(record[key])) record[key].forEach(add);
    }
  }
  const matches = candidates.filter(item => item.objectId === file.objectId || item.id === file.objectId || mateFileReferenceFromUrl(item.url, '')?.objectId === file.objectId);
  const mimeType = matches.map(item => item.mediaType || item.mimeType).find(value => typeof value === 'string');
  const sizeBytes = matches.map(item => item.sizeBytes).find(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  return { ...(typeof mimeType === 'string' ? { mimeType } : {}), ...(typeof sizeBytes === 'number' ? { sizeBytes } : {}) };
}

/** Ignore code and images while finding Markdown file cards already rendered in the text. */
export function markdownFileUrls(text: string): string[] {
  const pattern = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_)|!?\[([^\]\n]+)\]\((\/api\/workspace-files\/[^)\s]+)\)/g;
  const urls: string[] = [];
  for (const match of text.matchAll(pattern)) {
    if (match[1] || match[0].startsWith('!')) continue;
    const file = mateFileReferenceFromUrl(match[3], match[2]);
    if (file) urls.push(file.url);
  }
  return urls;
}
