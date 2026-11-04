import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp,readFile,rm,stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { portableFtsBackup,backupFtsDatabase } from '../src/databaseBackup.mjs';
const dump=`PRAGMA foreign_keys=OFF;
CREATE TABLE chunks(id INTEGER PRIMARY KEY,text TEXT,parent_id INTEGER REFERENCES parents(id),data BLOB,optional TEXT);
CREATE TABLE parents(id INTEGER PRIMARY KEY);
CREATE VIRTUAL TABLE chunks_fts USING fts5(text,content='chunks',content_rowid='id',tokenize='trigram');
INSERT INTO chunks VALUES(9007199254740993,'An owner''s acceptance marker',1,X'0001ff',NULL);
INSERT INTO parents VALUES(1);
INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');
CREATE INDEX chunks_parent ON chunks(parent_id);
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid,text) VALUES(NEW.id,NEW.text);END;
CREATE VIEW chunk_names AS SELECT text FROM chunks;`;
test('FTS snapshot converts to ordinary import SQL preserving data, index and triggers',()=>{
 const sql=portableFtsBackup(dump),db=new DatabaseSync(':memory:');
 try{
  assert.doesNotMatch(sql,/writable_schema|INSERT INTO "chunks_fts_data"/);
  db.exec('PRAGMA foreign_keys=ON;'+sql);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  const statement=db.prepare('SELECT * FROM chunks');statement.setReadBigInts(true);const row=statement.get();
  assert.equal(row.id,9007199254740993n);assert.equal(row.text,"An owner's acceptance marker");assert.deepEqual(Buffer.from(row.data),Buffer.from([0,1,255]));assert.equal(row.optional,null);
  assert.equal(db.prepare("SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'acceptance'").get().n,1);
  db.exec("INSERT INTO chunks VALUES(2,'new searchable marker',1,NULL,NULL)");assert.equal(db.prepare("SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'searchable'").get().n,1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM chunk_names').get().n,2);
 }finally{db.close();}
});
test('export polling uses the snapshot bookmark and downloads without API credentials',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'matrix-backup-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=join(dir,'knowledge.sql');let calls=0;
 const cf={request:async(path,{body})=>{assert.equal(path,'/d1/database/test-db/export');assert.equal(body.dump_options.compatibility,'sqlite3_cli_only');if(calls++===0)return{status:'active',at_bookmark:'snapshot-1'};assert.equal(body.current_bookmark,'snapshot-1');return{status:'complete',result:{signed_url:'https://export.example.test/signed'}};}};
 await backupFtsDatabase(cf,'test-db',file,{wait:async()=>{},fetchImpl:async(url,options)=>{assert.equal(url.origin,'https://export.example.test');assert.equal(options.redirect,'error');assert.equal(options.headers,undefined);return new Response(dump);}});
 assert.match(await readFile(file,'utf8'),/CREATE VIRTUAL TABLE/);assert.equal((await stat(file)).mode&0o777,0o600);
 await assert.rejects(backupFtsDatabase({request:async()=>({error:'private upstream detail'})},'test-db',file),{message:'database_snapshot_export_failed'});
});
