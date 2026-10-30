import assert from "node:assert/strict";
import { test } from "node:test";
import { messageLinks } from "./chatLinks.ts";
test("keeps web citations and service authorization visible without duplicating files", () => {
  const links = messageLinks({parts:[{type:"data-mate-citations",data:{sources:[{url:"https://example.test/source",title:"Source"},{relativePath:"Reports/latest.md",serviceName:"Knowledge"},{objectId:"file-1",relativePath:"File"}]}},{type:"tool-mate_mcp_manage",state:"output-available",output:{authorizationUrl:"https://example.test/authorize?state=opaque",connection:{name:"Service"}}}]});
  assert.equal(links.length,3); assert.equal(links[2].authorization,true);
});
test("never exposes invalid or credential-bearing authorization links", () => {
  for (const url of ["javascript:alert(1)","http://example.test/auth","https://user:pass@example.test/auth"]) {
    assert.deepEqual(messageLinks({parts:[{type:"tool-mate_mcp_manage",state:"output-available",output:{authorizationUrl:url}}]}),[]);
  }
});
