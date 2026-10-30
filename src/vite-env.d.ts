/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_KNOWLEDGE_WORKER_URL?: string;
  readonly VITE_APPS_WORKER_URL?: string;
  readonly VITE_LITELLM_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
