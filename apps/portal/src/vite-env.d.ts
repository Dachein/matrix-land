/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PORTAL_LIVE_WSS_URL?: string;
  readonly VITE_PORTAL_LIVE_WORKSPACE_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
