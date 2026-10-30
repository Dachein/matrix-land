import assert from 'node:assert/strict';
import {test} from 'node:test';
import {uploadElapsedTime} from './uploadProgress.ts';
import {materialFileName} from './fileTypes.ts';
test('upload elapsed time starts at zero and follows wall time across backgrounding',()=>{
  assert.equal(uploadElapsedTime(1000,1000),'00:00');assert.equal(uploadElapsedTime(1000,2250),'00:01');assert.equal(uploadElapsedTime(1000,122000),'02:01');assert.equal(uploadElapsedTime(1000,0),'00:00');
});
test('forwarded hash-named images and PDFs keep the MIME-matching extension',()=>{
  assert.equal(materialFileName('abc123','image/png'),'abc123.png');assert.equal(materialFileName('hash','application/pdf'),'hash.pdf');assert.equal(materialFileName('照片.JPG','image/jpeg'),'照片.JPG');assert.equal(materialFileName('hash','application/octet-stream'),'hash');
});
