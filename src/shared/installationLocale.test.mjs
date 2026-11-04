import test from 'node:test';import assert from 'node:assert/strict';
import{initialInstallationLocale}from'./installationLocale.ts';
test('official language takes precedence over the browser while personal choices are retained',()=>{
 assert.equal(initialInstallationLocale(null,'en','zh-CN'),'en');
 assert.equal(initialInstallationLocale(null,'zh-CN','en-US'),'zh-CN');
 assert.equal(initialInstallationLocale('zh-CN','en','en-US'),'zh-CN');
 assert.equal(initialInstallationLocale('en-US','zh-CN','zh-CN'),'en');
 assert.equal(initialInstallationLocale('invalid','en','zh-CN'),'en');
 assert.equal(initialInstallationLocale(null,undefined,'en-US'),'en');
});
