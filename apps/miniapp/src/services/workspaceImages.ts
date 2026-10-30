import { downloadWorkspaceFile, downloadWorkspaceThumbnail } from './api';
import { createChatImageCache } from './chatImages';

// Separate caches: a thumbnail must never be mistaken for the full-resolution preview.
export const workspaceImages = createChatImageCache(downloadWorkspaceFile, 4);
export const workspaceThumbnails = createChatImageCache(downloadWorkspaceThumbnail, 24);
