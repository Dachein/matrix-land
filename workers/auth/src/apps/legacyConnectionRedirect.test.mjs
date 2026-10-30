import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.ts';
test('new installations do not redirect to a former company connector',async()=>{
 const response=await worker.fetch(new Request('https://portal.test/auth/microsoft365?app_id=old-app'),{});
 assert.equal(response.status,404);assert.equal(response.headers.has('location'),false);
});
