import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { command } from './process.mjs';
import { resolveSecret } from './config.mjs';
const yaml=JSON.stringify;
const quote=value=>"'"+String(value).replace(/'/g,"'\\''")+"'";
export function renderServerBundle(config,vault,env=process.env){
 const m=config.models,s=m.server,host=new URL(m.baseUrl).hostname;
 const master=resolveSecret(m.provisioningSecretRef,env),provider=resolveSecret(s.providerSecretRef,env);
 for(const value of [master,provider])if(/[\r\n\0]/.test(value))throw new Error('server_secret_contains_newline');
 const compose=`name: ${config.installationId}-models\nservices:\n  postgres:\n    image: ${yaml(s.postgresImage)}\n    restart: unless-stopped\n    environment:\n      POSTGRES_DB: litellm\n      POSTGRES_USER: litellm\n      POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password\n    secrets: [postgres_password]\n    volumes: ["postgres-data:/var/lib/postgresql/data"]\n    healthcheck:\n      test: ["CMD-SHELL", "pg_isready -U litellm -d litellm"]\n      interval: 5s\n      retries: 20\n  litellm:\n    image: ${yaml(s.image)}\n    restart: unless-stopped\n    command: ["--config", "/app/config.yaml", "--port", "4000"]\n    env_file: .env\n    volumes: ["./config.yaml:/app/config.yaml:ro"]\n    depends_on:\n      postgres:\n        condition: service_healthy\n  caddy:\n    image: ${yaml(s.caddyImage)}\n    restart: unless-stopped\n    ports: ["80:80", "443:443"]\n    volumes: ["./Caddyfile:/etc/caddy/Caddyfile:ro", "caddy-data:/data", "caddy-config:/config"]\n    depends_on: [litellm]\nsecrets:\n  postgres_password:\n    file: ./postgres-password\nvolumes:\n  postgres-data:\n  caddy-data:\n  caddy-config:\n`;
 const envQuote=v=>`'${v.replace(/'/g,"\\'")}'`;
 return {'compose.yaml':compose,'config.yaml':`model_list:\n  - model_name: ${yaml(m.models[0])}\n    litellm_params:\n      model: ${yaml(s.providerModel)}\n      api_key: os.environ/PROVIDER_API_KEY\ngeneral_settings:\n  master_key: os.environ/LITELLM_MASTER_KEY\n  database_url: os.environ/DATABASE_URL\n`,'.env':`LITELLM_MASTER_KEY=${envQuote(master)}\nLITELLM_SALT_KEY=${envQuote(vault.LITELLM_SALT_KEY)}\nPROVIDER_API_KEY=${envQuote(provider)}\nDATABASE_URL=${envQuote(`postgresql://litellm:${vault.LITELLM_DATABASE_PASSWORD}@postgres:5432/litellm`)}\n`,'postgres-password':vault.LITELLM_DATABASE_PASSWORD,'Caddyfile':`${host} {\n reverse_proxy litellm:4000\n}\n`,'installation.json':JSON.stringify({installationId:config.installationId,serverMode:'single-host',images:[s.image,s.postgresImage,s.caddyImage]})};
}
export function sshArgs(server){return ['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile=${server.knownHostsFile}`,'-o','ConnectTimeout=15','-i',server.identityFile,'-p',String(server.port),`${server.user}@${server.host}`];}
export async function deployServer(config,vault,{saveVault,env=process.env,run=command}){
 const s=config.models.server,d=s.directory;vault.LITELLM_DATABASE_PASSWORD??=randomBytes(32).toString('hex');vault.LITELLM_SALT_KEY??=randomBytes(32).toString('hex');await saveVault();
 const prefix=sshArgs(s);
 const inspection=await run('ssh',[...prefix,`set -eu; command -v docker >/dev/null; docker compose version; uname -m; command -v tar >/dev/null; command -v ss >/dev/null; df -Pk /opt; test $(df -Pk /opt | awk 'NR==2 {print $4}') -ge 5242880; if test -d ${d}; then cat ${d}/installation.json; else test -z "$(ss -H -ltn '( sport = :80 or sport = :443 )')"; echo WORKSPACE_NEW_DIRECTORY; fi`],{env,timeout:60000});
 if(!/\b(x86_64|aarch64)\b/.test(inspection))throw new Error('server_architecture_unsupported');
 if(!inspection.includes('WORKSPACE_NEW_DIRECTORY')){let owned=false;for(const line of inspection.split('\n'))try{if(JSON.parse(line).installationId===config.installationId)owned=true;}catch{}if(!owned)throw new Error('server_directory_not_owned');}
 if(!inspection.includes('WORKSPACE_NEW_DIRECTORY'))await backupAndRestoreServer(config,{env,run,label:'pre-upgrade'});
 const bundle=renderServerBundle(config,vault,env),local=await mkdtemp(resolve(tmpdir(),'workspace-server-'));
 try{for(const [name,content]of Object.entries(bundle))await writeFile(resolve(local,name),content,{mode:0o600});
  // tar bytes are sent through stdin; credentials never become command arguments.
  const tar=await run('tar',['-czf',resolve(local,'bundle.tgz'),...Object.keys(bundle)],{cwd:local,env});
  const {readFile}=await import('node:fs/promises');
  await run('ssh',[...prefix,`set -eu; umask 077; mkdir -p ${d}; tar -xzf - -C ${d}; cd ${d}; docker compose config --quiet; docker compose pull; docker compose up -d --wait --wait-timeout 180`],{input:await readFile(resolve(local,'bundle.tgz')),env,timeout:600000});
  return {host:s.host,directory:d,images:[s.image,s.postgresImage,s.caddyImage],restoreDrill:'runs-after-model-initialization'};
 }finally{await rm(local,{recursive:true,force:true});}
}

export function restoreScript(config,{label='verified',suffix=randomBytes(8).toString('hex')}={}) {
 if(!/^[a-z-]+$/.test(label)||!/^[a-f0-9]{16}$/.test(suffix))throw new Error('invalid_backup_label');
 const s=config.models.server,d=s.directory,name=`workspace-restore-${suffix}`,backup=`backups/${label}-${suffix}.dump`;
 return {backup,script:`set -eu
cd ${d}
umask 077
mkdir -p backups
docker compose exec -T postgres pg_dump -U litellm -d litellm -Fc > ${backup}
test -s ${backup}
chmod 600 ${backup}
docker compose exec -T postgres pg_restore -l < ${backup} >/dev/null
docker volume create ${name} >/dev/null
cleanup() { docker rm -f ${name} >/dev/null 2>&1 || true; docker volume rm ${name} >/dev/null 2>&1 || true; }
trap cleanup EXIT HUP INT TERM
docker run -d --name ${name} --network none -e POSTGRES_HOST_AUTH_METHOD=trust --mount type=volume,src=${name},dst=/var/lib/postgresql/data ${quote(s.postgresImage)} >/dev/null
attempt=0
until docker exec ${name} pg_isready -U postgres >/dev/null 2>&1; do attempt=$((attempt+1)); test "$attempt" -lt 60; sleep 2; done
docker exec -i ${name} pg_restore -U postgres -d postgres --no-owner --exit-on-error < ${backup}
docker exec ${name} psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM information_schema.tables WHERE table_schema = '\''public'\'';' >/dev/null
echo WORKSPACE_RESTORE_VERIFIED
`};
}
export async function backupAndRestoreServer(config,{env=process.env,run=command,label='verified'}={}) {
 const {backup,script}=restoreScript(config,{label});
 const result=await run('ssh',[...sshArgs(config.models.server),script],{env,timeout:300000});
 if(!result.includes('WORKSPACE_RESTORE_VERIFIED'))throw new Error('isolated_restore_not_verified');
 return {backup,restoreDrill:'passed',isolation:'temporary-container-network-none',verifiedAt:new Date().toISOString()};
}
