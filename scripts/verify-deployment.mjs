import {writeFile,mkdir,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildPlan} from '../packages/installer/src/plan.mjs';
import {renderWorker} from '../packages/installer/src/render.mjs';
import {command} from '../packages/installer/src/process.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const example=JSON.parse(await readFile(resolve(root,'config/installation.example.json'),'utf8'));
const plan=await buildPlan({...example,modules:['mate','knowledge','studio','connections','discussions','mail','stream','miniapp','operations'],models:{mode:'existing',baseUrl:'https://models.example.com',teamId:'test',models:['test'],maxBudget:100,provisioningSecretRef:'env:TEST_ADMIN',serviceSecretRef:'env:TEST_SERVICE'}},root);
const state={resources:Object.fromEntries(plan.resources.map(r=>[`${r.kind}:${r.key}`,{name:r.name,id:r.kind==='d1'?'00000000-0000-4000-8000-000000000001':r.name}]))};
const out=resolve(root,'.workspace/validation');await mkdir(out,{recursive:true});let failures=0;
for(const name of plan.services.filter(n=>n!=='portal')){const path=resolve(out,`${name}.json`);await writeFile(path,JSON.stringify(renderWorker(name,plan,state,root),null,2));try{const output=await command(process.execPath,[resolve(root,'node_modules/wrangler/bin/wrangler.js'),'deploy','--dry-run','--config',path,'--outdir',resolve(out,'bundles',name),'--no-autoconfig'],{cwd:root,env:{...process.env,WRANGLER_SEND_METRICS:'false',CI:'1'},completionMarker:'--dry-run: exiting now.'});await writeFile(resolve(out,`${name}.log`),output);console.log(`PASS ${name}`);}catch(e){failures++;await writeFile(resolve(out,`${name}.log`),e.output??e.message);console.error(`FAIL ${name}: see ${resolve(out,`${name}.log`)}`);}}
process.exitCode=failures?1:0;
