export const workspaceModuleNames = ['models','mate','knowledge','studio','connections','discussions','mail','stream','miniapp','operations'] as const;
export type WorkspaceModule = typeof workspaceModuleNames[number];
export function workspaceModulesFromEnv(env: {WORKSPACE_MODULES_JSON?: string}): WorkspaceModule[] {
 if (!env.WORKSPACE_MODULES_JSON) return [];
 let value: unknown; try { value=JSON.parse(env.WORKSPACE_MODULES_JSON); } catch { throw new Error('invalid_workspace_modules'); }
 if (!Array.isArray(value) || value.some(item=>!workspaceModuleNames.includes(item))) throw new Error('invalid_workspace_modules');
 return [...new Set(value)] as WorkspaceModule[];
}
export function portalPageModule(page: string): WorkspaceModule | undefined {
 if (['catalog','app','skill','studio','admin-hub-review'].includes(page)) return 'studio';
 if (['models','model-status','admin'].includes(page)) return 'models';
 if (['mate','mate-embed','mate-preview'].includes(page)) return 'mate';
 if (['knowledge','admin-knowledge'].includes(page)) return 'knowledge';
 if (['connections','admin-mcp-connections'].includes(page)) return 'connections';
 if (['post','discussions'].includes(page)) return 'discussions';
 return undefined;
}
export function portalApiModule(path: string): WorkspaceModule | undefined {
 if (/^(apps|skills|publication|listings)(\/|$)/.test(path)) return 'studio';
 if (/^(llm-gateway|models)(\/|$)/.test(path)) return 'models';
 if (/^(mate|mates|mate-runtime|workspace-files)(\/|$)/.test(path)) return 'mate';
 if (/^knowledge(\/|$)/.test(path)) return 'knowledge';
 if (/^mcp(\/|$)/.test(path)) return 'connections';
 if (/^(forum|posts|topics)(\/|$)/.test(path)) return 'discussions';
 if (/^backups(\/|$)/.test(path)) return 'operations';
 return undefined;
}
