import assert from 'node:assert/strict';
import {afterEach,describe,it} from 'node:test';
import Taro from '@tarojs/taro';
import {chooseFiles,isPickerCancelled} from './fileSelection.ts';
const original={...Taro};
afterEach(()=>{for(const k of Object.keys(Taro))if(!(k in original))delete Taro[k];Object.assign(Taro,original);});
describe('native attachment picking',()=>{
  it('allows chat photos as well as documents and respects the remaining quota',async()=>{
    Taro.chooseMessageFile=async options=>{assert.equal(options.type,'all');assert.equal(options.count,2);return {tempFiles:[{path:'a',name:'A.png',size:12},{path:'b',name:'B.pdf',size:10},{path:'c',name:'unexpected',size:1}]};};
    assert.deepEqual((await chooseFiles('chat',2)).map(f=>f.name),['A.png','B.pdf']);
  });
  it('never opens a picker when no slots remain',async()=>{
    Taro.chooseMessageFile=async()=>{throw Error('must not open');};
    assert.deepEqual(await chooseFiles('chat',0),[]);
  });
  it('preserves HEIC and PNG types for album images',async()=>{
    Taro.chooseMedia=async()=>({tempFiles:[{tempFilePath:'/tmp/image.heic',size:9},{tempFilePath:'/tmp/wx_tmp',size:12}]});
    Taro.getImageInfo=async()=>({type:'png'});
    const files=await chooseFiles('album',2);assert.match(files[0].name,/\.heic$/);assert.equal(files[0].type,'image/heic');assert.equal(files[1].type,'image/png');
  });
  it('treats both native and Promise cancellation as cancellation, not network failure',()=>{
    assert.equal(isPickerCancelled({errMsg:'chooseMedia:fail cancel'}),true);
    assert.equal(isPickerCancelled(Error('user cancel')),true);assert.equal(isPickerCancelled(Error('network error')),false);
  });
});
