import assert from 'node:assert/strict';
import {afterEach,describe,it} from 'node:test';
import Taro from '@tarojs/taro';
import {openNativeFilePreview,sharePreviewFile} from './fileActions.ts';
const original={...Taro};
afterEach(()=>{for(const k of Object.keys(Taro))if(!(k in original))delete Taro[k];Object.assign(Taro,original);});
describe('shared native viewer dispatch',()=>{
  it('opens all document formats with explicit native type and the system file menu',async()=>{
    for(const ext of ['pdf','doc','docx','xls','xlsx','ppt','pptx']){
      Taro.openDocument=async options=>{assert.equal(options.fileType,ext);assert.equal(options.showMenu,true);assert.equal(options.filePath,'/tmp/download');};
      await openNativeFilePreview('/tmp/download',{id:'one',name:`中文报告.${ext.toUpperCase()}`});
    }
  });
  it('dispatches user PDFs and AI PDFs to the exact same native API',async()=>{
    const calls=[];Taro.openDocument=async options=>calls.push(options);
    for(const id of ['user-upload','ai-generated'])await openNativeFilePreview('/tmp/report',{id,name:'报告.pdf',mimeType:'application/pdf'});
    assert.deepEqual(calls[0],calls[1]);assert.equal(calls.length,2);
  });
  it('uses previewImage for images from either origin',async()=>{
    let count=0;Taro.previewImage=async options=>{count++;assert.deepEqual(options,{current:'/tmp/photo',urls:['/tmp/photo']});};
    for(const id of ['user-photo','generated-image'])await openNativeFilePreview('/tmp/photo',{id,name:'图片.png'});
    assert.equal(count,2);
  });
  it('does not send inline HTML, CSV or ZIP to a native document viewer',async()=>{
    Taro.openDocument=Taro.previewImage=async()=>{throw Error('must not open');};
    for(const name of ['page.html','table.csv','archive.zip'])await assert.rejects(()=>openNativeFilePreview('/tmp/path',{id:'one',name}),/document_type_unsupported/);
  });
  it('keeps failed document opens retryable rather than claiming success',async()=>{
    let count=0;Taro.openDocument=async()=>{if(++count===1)throw Error('corrupt_or_transient');};
    await assert.rejects(()=>openNativeFilePreview('/tmp/doc',{id:'one',name:'file.pdf'}));
    await openNativeFilePreview('/tmp/doc',{id:'one',name:'file.pdf'});assert.equal(count,2);
  });
  it('does not invent a temporary path when a download did not produce one',async()=>{
    await assert.rejects(()=>openNativeFilePreview('',{id:'one',name:'file.pdf'}),/document_path_missing/);
  });
  it('offers an Office file through the user-controlled system share sheet',async()=>{
    let options;Taro.shareFileMessage=async value=>{options=value;};
    await sharePreviewFile('/tmp/report.docx',{id:'office',name:'季度报告.docx'});
    assert.deepEqual(options,{filePath:'/tmp/report.docx',fileName:'季度报告.docx'});
  });
  it('reports unavailable file sharing and preserves cancellation',async()=>{
    delete Taro.shareFileMessage;
    await assert.rejects(()=>sharePreviewFile('/tmp/report',{id:'one',name:'report.xlsx'}),/file_share_unavailable/);
    Taro.shareFileMessage=async()=>{throw Error('shareFileMessage:fail cancel');};
    await assert.rejects(()=>sharePreviewFile('/tmp/report',{id:'one',name:'report.xlsx'}),/cancel/);
  });
});
