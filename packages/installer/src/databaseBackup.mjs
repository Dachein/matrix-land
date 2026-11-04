import { DatabaseSync } from 'node:sqlite';
import { writeFile } from 'node:fs/promises';
const identifier=value=>'"'+value.replaceAll('"','""')+'"';
const literal=value=>value===null?'NULL':typeof value==='bigint'||typeof value==='number'?String(value):ArrayBuffer.isView(value)?`X'${Buffer.from(value.buffer,value.byteOffset,value.byteLength).toString('hex')}'`:`CAST(X'${Buffer.from(value).toString('hex')}' AS TEXT)`;

// Recreate virtual tables through supported SQL rather than importing SQLite's
// writable_schema/shadow-table dump, which D1 rejects. FTS data is derived from
// its content table in the same immutable export snapshot.
export function portableFtsBackup(dump){
 const db=new DatabaseSync(':memory:');
 try{
  db.enableDefensive?.(false);db.exec(dump);
  if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('backup_snapshot_integrity_failed');
  const schema=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY rowid").all();
  const tables=db.prepare('PRAGMA table_list').all().filter(x=>x.schema==='main'&&['table','virtual'].includes(x.type)&&!x.name.startsWith('sqlite_')&&!x.name.startsWith('_cf_'));
  const names=new Set(tables.map(x=>x.name)),virtual=tables.filter(x=>x.type==='virtual');
  for(const table of virtual){const sql=schema.find(x=>x.name===table.name)?.sql??'';if(!/\bUSING\s+fts5\s*\(/i.test(sql)||!/\bcontent\s*=\s*'[^']+'/i.test(sql))throw new Error('backup_virtual_table_unsupported');}
  const lines=['PRAGMA defer_foreign_keys=ON;'];
  for(const entry of schema.filter(x=>x.type==='table'&&names.has(x.name)))lines.push(entry.sql+';');
  const ordered=[],visited=new Set(),visiting=new Set();
  function visit(table){
   if(visited.has(table.name))return;
   if(visiting.has(table.name))throw new Error('backup_cyclic_table_dependencies');
   visiting.add(table.name);
   for(const key of db.prepare(`PRAGMA foreign_key_list(${identifier(table.name)})`).all()){
    const parent=tables.find(x=>x.name===key.table&&x.type==='table');
    if(parent&&parent.name!==table.name)visit(parent);
   }
   visiting.delete(table.name);visited.add(table.name);ordered.push(table);
  }
  for(const table of tables.filter(x=>x.type==='table'))visit(table);
  for(const table of ordered){
   const columns=db.prepare(`PRAGMA table_xinfo(${identifier(table.name)})`).all().filter(x=>x.hidden===0).map(x=>x.name);
   const statement=db.prepare(`SELECT ${columns.map(identifier).join(',')} FROM ${identifier(table.name)}`);statement.setReadBigInts(true);
   for(const row of statement.iterate())lines.push(`INSERT INTO ${identifier(table.name)}(${columns.map(identifier).join(',')}) VALUES(${columns.map(name=>literal(row[name])).join(',')});`);
  }
  for(const table of virtual)lines.push(`INSERT INTO ${identifier(table.name)}(${identifier(table.name)}) VALUES('rebuild');`);
  for(const entry of schema.filter(x=>['index','view','trigger'].includes(x.type)))lines.push(entry.sql+';');
  lines.push('PRAGMA defer_foreign_keys=OFF;');return lines.join('\n')+'\n';
 }finally{db.close();}
}

export async function backupFtsDatabase(cf,databaseId,file,{fetchImpl=fetch,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 let bookmark;
 for(let attempt=0;attempt<120;attempt++){
  const result=await cf.request(`/d1/database/${databaseId}/export`,{method:'POST',body:{output_format:'polling',dump_options:{compatibility:'sqlite3_cli_only'},...(bookmark?{current_bookmark:bookmark}:{})}});
  if(result.error||result.status==='error')throw new Error('database_snapshot_export_failed');
  bookmark=result.at_bookmark??bookmark;
  if(result.status==='complete'){
   const url=new URL(result.result?.signed_url??'');if(url.protocol!=='https:'||url.username||url.password)throw new Error('database_snapshot_url_invalid');
   const response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(120000)});
   if(!response.ok)throw new Error('database_snapshot_download_failed');
   const sql=portableFtsBackup(await response.text());await writeFile(file,sql,{mode:0o600});return;
  }
  if(!bookmark)throw new Error('database_snapshot_bookmark_missing');await wait(1000);
 }
 throw new Error('database_snapshot_export_timeout');
}
