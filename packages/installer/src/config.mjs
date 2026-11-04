import { z } from 'zod';
import { resolvePlatformBrand } from '../../../src/shared/platformBrand.ts';
import { resolveInstallationDomains } from '../../../src/shared/installationDomains.ts';
const secret=z.string().regex(/^env:[A-Z][A-Z0-9_]*$/),uuid=z.string().uuid();
const https=z.string().url().refine(value=>{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&!u.port&&u.pathname==='/'&&!/^(localhost|127\.|169\.254\.|0\.|\[)/.test(u.hostname);},'Use an HTTPS origin without credentials, path or port');
const ssh=z.object({host:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]+$/),user:z.string().regex(/^[a-z_][a-z0-9_-]*$/),port:z.number().int().min(1).max(65535).default(22),identityFile:z.string().startsWith('/'),knownHostsFile:z.string().startsWith('/'),directory:z.string().regex(/^\/opt\/[a-z][a-z0-9-]+$/),image:z.string().regex(/^ghcr\.io\/berriai\/litellm[a-zA-Z0-9_.:/-]*@sha256:[a-f0-9]{64}$/),postgresImage:z.string().regex(/^postgres:(?:16|17)[a-zA-Z0-9_.-]*@sha256:[a-f0-9]{64}$/),caddyImage:z.string().regex(/^caddy:[a-zA-Z0-9_.-]+@sha256:[a-f0-9]{64}$/),providerSecretRef:secret,providerModel:z.string().regex(/^[a-zA-Z0-9_./:-]+$/)}).strict();
const modelsBase={baseUrl:https,models:z.array(z.string().min(1).max(100)).min(1),maxBudget:z.number().positive(),provisioningSecretRef:secret};
const models=z.discriminatedUnion('mode',[z.object({mode:z.literal('disabled')}).strict(),z.object({mode:z.literal('existing'),...modelsBase,teamId:z.string().min(1),serviceSecretRef:secret}).strict(),z.object({mode:z.literal('server'),...modelsBase,server:ssh}).strict()]);
const entra=z.discriminatedUnion('mode',[z.object({mode:z.literal('disabled')}).strict(),z.object({mode:z.literal('existing'),tenantId:uuid,clientId:uuid,clientSecretRef:secret,expiresAt:z.string().datetime()}).strict(),z.object({mode:z.literal('create'),tenantId:uuid,graphTokenRef:secret,expiresAt:z.string().datetime()}).strict()]);
export const schema=z.object({$schema:z.literal('https://frontier-workspace.org/schemas/installation/v1'),schemaVersion:z.literal(1),installationId:z.string().regex(/^[a-z][a-z0-9-]{2,23}$/),brand:z.record(z.string(),z.unknown()).default({}),domains:z.record(z.string(),z.unknown()),cloudflare:z.object({accountId:z.string().regex(/^[a-f0-9]{32}$/),zoneId:z.string().regex(/^[a-f0-9]{32}$/),apiTokenRef:secret,runtimeTokenRef:secret.optional()}).strict(),identity:z.object({allowedEmailDomains:z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).min(1),senderEmail:z.string().email(),ownerEmail:z.string().email(),entra:entra.default({mode:'disabled'})}).strict(),modules:z.array(z.enum(['models','mate','knowledge','studio','connections','discussions','mail','stream','miniapp','operations'])).default([]),models:models.default({mode:'disabled'})}).strict();
export function resolveConfig(input){const c=schema.parse(input);c.brand=resolvePlatformBrand(c.brand);c.domains=resolveInstallationDomains(c.domains);c.identity.ownerEmail=c.identity.ownerEmail.toLowerCase();if(!c.identity.allowedEmailDomains.includes(c.identity.ownerEmail.split('@')[1]))throw new Error('owner_email_outside_allowlist');if(c.modules.includes('models')&&c.models.mode==='disabled')throw new Error('models_configuration_required');if(c.models.mode!=='disabled'&&!c.modules.includes('models'))c.modules.push('models');if(c.modules.some(x=>['mate','mail'].includes(x))&&c.models.mode==='disabled')throw new Error('mate_requires_models');if(c.identity.entra.mode!=='disabled'&&Date.parse(c.identity.entra.expiresAt)<=Date.now())throw new Error('entra_credential_expired');if(c.models.mode==='server'&&c.models.models.length!==1)throw new Error('server_mode_requires_one_initial_model');for(const [module,deps] of Object.entries({mate:['studio','models','connections','mail'],mail:['mate','studio','models','connections'],operations:['studio'],stream:['studio'],miniapp:['knowledge']}))if(c.modules.includes(module))c.modules.push(...deps);c.modules=[...new Set(c.modules)].sort();return c;}
export function resolveSecret(ref,env=process.env){const value=env[ref.slice(4)];if(!value)throw new Error(`missing_secret_reference:${ref}`);return value;}
// Check every configured credential before creating local state or cloud resources.
// Repeat this on resume too: a successful preflight from a prior process does not
// guarantee that credentials are still present in the new process environment.
export function validateCredentials(config,env=process.env){
 if(config.modules.some(x=>['studio','mate','mail','stream','operations'].includes(x))&&!config.cloudflare.runtimeTokenRef)throw new Error('cloudflare_runtime_token_reference_required');
 function visit(value){
  if(typeof value==='string'&&/^env:[A-Z][A-Z0-9_]*$/.test(value))resolveSecret(value,env);
  else if(value&&typeof value==='object')for(const child of Object.values(value))visit(child);
 }
 visit(config);
}
export function installationCredentials(config,env){
 const values={};
 function visit(value){
  if(typeof value==='string'&&/^env:[A-Z][A-Z0-9_]*$/.test(value))values[value.slice(4)]=resolveSecret(value,env);
  else if(value&&typeof value==='object')for(const child of Object.values(value))visit(child);
 }
 visit(config);return values;
}
