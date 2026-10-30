import assert from 'node:assert/strict';
import {it} from 'node:test';
import {fileCardDetails,chatFileMetadata,markdownFileUrls} from './fileCard.ts';
const file={objectId:'art_123',url:'/api/workspace-files/art_123/download',fileName:'报告.pdf'};
it('formats supported types and known file sizes without fabricating unknown sizes',()=>{
 assert.deepEqual(fileCardDetails('报告.PDF','',2048),{type:'PDF',size:'2.0 KB',supported:true});
 assert.equal(fileCardDetails('report','application/pdf').type,'PDF');
 for(const size of [undefined,NaN,-1,Infinity])assert.equal(fileCardDetails('report.pdf','',size).size,undefined);
 assert.equal(fileCardDetails('empty.txt','',0).size,'0 B');
 assert.equal(fileCardDetails('archive.zip','',1048576).supported,false);
});
it('reads size and MIME only from matching user or generated file metadata',()=>{
 assert.deepEqual(chatFileMetadata(file,[{type:'file',url:'/api/workspace-files/art_123/raw',mediaType:'application/pdf',sizeBytes:2048}]),{mimeType:'application/pdf',sizeBytes:2048});
 assert.deepEqual(chatFileMetadata(file,[{type:'tool-workspace_file_create',output:{file:{objectId:'art_123',mimeType:'application/pdf',sizeBytes:4096}}}]),{mimeType:'application/pdf',sizeBytes:4096});
 assert.deepEqual(chatFileMetadata(file,[{type:'tool-workspace_file_create',output:{file:{objectId:'art_other',sizeBytes:4096}}}]),{});
});
it('deduplicates Markdown file cards against tool references while excluding code and images',()=>{
 assert.deepEqual(markdownFileUrls(`[报告](${file.url})`),[file.url]);
 const link='[报告]('+file.url+')';
 for(const text of ['!'+link, '**'+link+'**', '```md\n'+link, '`'+link+'`', '```md\n'+link+'\n```','[网站](https://example.test/report.pdf)'])assert.deepEqual(markdownFileUrls(text),[]);
});
