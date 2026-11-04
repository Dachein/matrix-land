import test from 'node:test';
import assert from 'node:assert/strict';
import {deployWithMetadataRetry} from '../src/deployRetry.mjs';
const target={accountId:'target-account',workerName:'test-auth'};
const failure=output=>Object.assign(new Error('deployment_failed'),{output});
const transient='Uploaded test-auth (2 sec)\nAPI /accounts/target-account/workers/workers/test-auth failed [code: 10007]';
test('post-upload metadata lag is retried for the intended account and worker',async()=>{
 let calls=0;const waits=[];
 const result=await deployWithMetadataRetry(async()=>{if(++calls===1)throw failure(transient);return 'deployed';},{...target,wait:async ms=>waits.push(ms)});
 assert.equal(result,'deployed');assert.equal(calls,2);assert.deepEqual(waits,[1500]);
});
test('metadata retries are bounded and do not retry other deployment failures',async()=>{
 for(const output of [transient,transient.replace('target-account','other-account'),transient.replace('10007','10000'),transient.replace('Uploaded test-auth (2 sec)','Uploading test-auth')]){
  let calls=0;const error=failure(output),waits=[];
  await assert.rejects(deployWithMetadataRetry(async()=>{calls++;throw error;},{...target,wait:async ms=>waits.push(ms)}),value=>value===error);
  assert.equal(calls,output===transient?3:1);assert.deepEqual(waits,output===transient?[1500,3000]:[]);
 }
});
