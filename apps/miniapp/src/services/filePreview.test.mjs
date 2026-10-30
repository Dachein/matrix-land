import assert from 'node:assert/strict';
import {describe,it} from 'node:test';
import {documentFileType,filePreviewKind,selectFilePreview,getFilePreview} from './filePreview.ts';
describe('unified file preview routing',()=>{
  it('routes PDF and every Office format to the native document viewer',()=>{
    for(const extension of ['pdf','doc','docx','xls','xlsx','ppt','pptx']){
      assert.equal(documentFileType(`季度报告.${extension.toUpperCase()}`),extension);
      assert.equal(filePreviewKind(`季度报告.${extension}`),extension==='pdf'?'pdf':'document');
    }
  });
  it('recognizes documents without an extension through MIME',()=>{
    assert.equal(filePreviewKind('generated file','application/pdf; charset=binary'),'pdf');
    assert.equal(documentFileType('download','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),'xlsx');
  });
  it('routes common images to the native image viewer',()=>{
    for(const extension of ['jpg','jpeg','png','gif','webp','bmp'])assert.equal(filePreviewKind(`photo.${extension}`),'image');
    assert.equal(filePreviewKind('photo','image/png'),'image');
  });
  it('routes HTML and Markdown from names or MIME to inline reading',()=>{
    for(const name of ['page.html','PAGE.HTM'])assert.equal(filePreviewKind(name),'html');
    for(const name of ['readme.md','NOTES.MARKDOWN','notes.mdown'])assert.equal(filePreviewKind(name),'markdown');
    assert.equal(filePreviewKind('report','text/html; charset=utf-8'),'html');
    assert.equal(filePreviewKind('report','text/x-markdown'),'markdown');
  });
  it('leaves other unsupported formats as metadata',()=>{
    for(const [name,mime] of [['rows.csv','text/csv'],['plain.txt','text/plain'],['data.json','application/json'],['image.svg','image/svg+xml'],['archive.zip','application/zip'],['video.mp4','video/mp4']])assert.equal(filePreviewKind(name,mime),'unsupported',name);
  });
  it('uses one selection contract for user files and AI-generated artifacts',()=>{
    for(const prefix of ['upload','generated']){
      const file={id:prefix,name:'报告.pdf',mimeType:'application/pdf',sizeBytes:2048,workspace:{session:{mate:{id:'mate'}},url:`/api/workspace-files/${prefix}/raw`}};
      selectFilePreview(file);assert.deepEqual(getFilePreview(prefix),file);assert.equal(getFilePreview('other'),undefined);
    }
  });
});
