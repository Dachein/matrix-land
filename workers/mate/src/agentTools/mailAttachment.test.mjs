import assert from "node:assert/strict";
import { test } from "node:test";
import { readMailAttachment } from "./mailAttachment.ts";
import { sourceMailOriginal, sourceMailAppArguments } from '../sourceMailOriginal.ts';

test('source attachment transfer checks every chunk and digest, infers PDF bytes and preserves the exact original', async()=>{
 const raw=Buffer.from('%PDF-original\n'+'receipt'.repeat(12000));
 const sha256=Buffer.from(await crypto.subtle.digest('SHA-256',raw)).toString('hex');
 const attachment={filename:'invoice.pdf',size:raw.length,sha256,mimeType:'application/octet-stream'};
 const read=async offset=>{const end=Math.min(offset+65536,raw.length);return {offset,totalBytes:raw.length,nextOffset:end<raw.length?end:null,filename:attachment.filename,data:raw.subarray(offset,end).toString('base64')};};
 const file=await sourceMailOriginal(attachment,read);
 assert.deepEqual(Buffer.from(file.base64,'base64'),raw);assert.equal(file.mediaType,'application/pdf');
 const schema={properties:{base64:{type:'string'},file_name:{type:'string'},mime_type:{type:'string'}}};
 const args=sourceMailAppArguments(file,schema,{item_id:'own-item',file_name:'forged.pdf',mime_type:'text/plain'});
 assert.equal(args.file_name,'invoice.pdf');assert.equal(args.mime_type,'application/pdf');assert.equal(args.base64,file.base64);
 await assert.rejects(sourceMailOriginal({...attachment,sha256:'0'.repeat(64)},read),/digest_mismatch/);
 await assert.rejects(sourceMailOriginal(attachment,async offset=>({...await read(offset),nextOffset:null})),/content_invalid/);
 assert.throws(()=>sourceMailAppArguments(file,schema,{base64:'forged'}),/app_tool_invalid/);
 assert.throws(()=>sourceMailAppArguments(file,{properties:{url:{type:'string'}}},{}),/app_tool_invalid/);
});

test("mail documents are converted only after all original byte chunks are verified", async () => {
  const original = new TextEncoder().encode("%PDF-original-invoice\n");
  const offsets = [];
  let conversions = 0;
  const env = { MATE_RUNTIME_SERVICE_TOKEN: "test-bridge", WORKSPACE_MCP_SERVICE: { async fetch(request) {
    const { offset } = await request.json(); offsets.push(offset);
    assert.equal(request.headers.get("x-workspace-runtime-mate-id"), "ada");
    const end = Math.min(offset + 5, original.length);
    return Response.json({ data: Buffer.from(original.subarray(offset, end)).toString("base64"), offset, totalBytes: original.length,
      nextOffset: end < original.length ? end : null, filename: "invoice.pdf", mimeType: "application/pdf" });
  } } };
  const toolEnv = { AI: { async toMarkdown(file) {
    conversions++; assert.deepEqual(new Uint8Array(await file.blob.arrayBuffer()), original);
    return { format: "markdown", data: "Original invoice" };
  } } };
  const output = await readMailAttachment(env, toolEnv, {}, { userId: "owner", orgId: "org" }, "ada", "mail-1", "attachment-1");
  assert.equal(output.size, original.length); assert.equal(output.content, "Original invoice");
  assert.deepEqual(offsets, [0, 5, 10, 15, 20]); assert.equal(conversions, 1);
});

test("partial or oversized mail originals never reach the document parser", async () => {
  for (const patch of [{ nextOffset: 0 }, { nextOffset: null }, { totalBytes: 21 * 1024 * 1024 }]) {
    const env = { MATE_RUNTIME_SERVICE_TOKEN: "test-bridge", WORKSPACE_MCP_SERVICE: { async fetch() {
      return Response.json({ offset: 0, totalBytes: 10, nextOffset: 5, data: Buffer.from("first").toString("base64"),
        filename: "invoice.pdf", mimeType: "application/pdf", ...patch });
    } } };
    const toolEnv = { AI: { toMarkdown() { assert.fail("incomplete originals must not be parsed"); } } };
    await assert.rejects(readMailAttachment(env, toolEnv, {}, { userId: "owner", orgId: "org" }, "ada", "mail-1", "attachment-1"), /mail_attachment_content_invalid/);
  }
});

test("native mail PDF preserves the owner bridge, verified SHA and bytes without exposing Base64 in UI output", async () => {
  const original = new TextEncoder().encode("%PDF-controlled-mail-original");
  let part;
  const env = { MATE_RUNTIME_SERVICE_TOKEN: "test-bridge", WORKSPACE_MCP_SERVICE: { async fetch(request) {
    const body = await request.json();
    assert.equal(body.messageId, "mail-1"); assert.equal(request.headers.get("x-workspace-runtime-mate-id"), "ada");
    return Response.json({ offset: 0, totalBytes: original.length, nextOffset: null,
      data: Buffer.from(original).toString("base64"), filename: "invoice.pdf", mimeType: "application/pdf" });
  } } };
  const output = await readMailAttachment(env, { AI: { toMarkdown() { assert.fail("native PDF is not converted"); } } }, {},
    { userId: "owner", orgId: "org" }, "ada", "mail-1", "attachment-1", undefined, value => { part = value; });
  assert.equal(output.format, "native_pdf"); assert.equal(output.contentTrust, "untrusted_email");
  assert.equal(output.sha256, Buffer.from(await crypto.subtle.digest("SHA-256", original)).toString("hex"));
  assert.deepEqual(part.data.data, original);
  assert.ok(!JSON.stringify(output).includes(Buffer.from(original).toString("base64")));
});
