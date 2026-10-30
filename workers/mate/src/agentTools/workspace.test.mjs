import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceFile, proxyWorkspaceFile, saveMateArtifactToKnowledge, uploadWorkspaceAttachment } from "./workspace.ts";
import { mateArtifactKey } from "../../../../src/shared/mateArtifacts.ts";
import { encodeIdentityPathSegment } from "../../../../src/shared/identityPath.ts";

const context = {
  appCode: "knowledge-access",
  appId: "knowledge-access-local",
  description: "Agent",
  displayName: "Knowledge Access Mate",
  exp: 2_000_000_000,
  iat: 1_900_000_000,
  user: { email: "user@example.test", id: "user-1", name: "User One" },
  version: 1
};

function artifactBucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, body, options) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, { bytes, options });
      return { size: bytes.byteLength };
    },
    async get(key) {
      const entry = objects.get(key);
      if (!entry) return null;
      return {
        body: new Response(entry.bytes).body,
        size: entry.bytes.byteLength,
        customMetadata: entry.options.customMetadata,
        httpMetadata: entry.options.httpMetadata,
        arrayBuffer: async () => entry.bytes.buffer.slice(0)
      };
    }
  };
}

test("identity path encoding preserves old keys and cannot collapse distinct identities", () => {
  const artifactId = "art_00000000-0000-4000-8000-000000000000";
  const owner = { orgId: "example-org", userId: "user-123_abc.def", mateId: "smartassist" };
  assert.equal(mateArtifactKey(owner, artifactId), `mate-artifacts/org/example-org/user/user-123_abc.def/mate/smartassist/artifacts/${artifactId}`);
  const ids = ["user@example.test", "user%40example.test", "user+tag@example.test", "user/tag", "user%2Ftag", "用户", "user?x#y", "user!x", "user_x"];
  const keys = ids.map((userId) => mateArtifactKey({ ...owner, userId }, artifactId));
  assert.equal(new Set(keys).size, ids.length);
  for (const id of ids) assert.equal(decodeURIComponent(encodeIdentityPathSegment(id)), id);
  for (const id of ["", ".", "..", "a\u0000b", "a\nb", "x".repeat(181), "\ud800"]) {
    assert.throws(() => mateArtifactKey({ ...owner, userId: id }, artifactId), /mate_artifact_owner_invalid/);
  }
});

test("email and special-character identities can upload, download and generate isolated files", async () => {
  const bucket = artifactBucket();
  const env = { MATE_ARTIFACTS: bucket };
  for (const userId of ["fiona.ashley.teo@example.test", "user+tag@example.test", "用户%/name?#"]) {
    const owner = { ...context, user: { ...context.user, id: userId } };
    const file = new File(["fixture"], "工作区.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const uploaded = await uploadWorkspaceAttachment(env, owner, file);
    const response = await proxyWorkspaceFile(env, owner, uploaded.file.objectId, "download", new Request("http://localhost"));
    assert.equal(await response.text(), "fixture");
    assert.match(response.headers.get("content-disposition"), /filename\*=UTF-8''%E5%B7%A5%E4%BD%9C%E5%8C%BA.xlsx/);
    const generated = await createWorkspaceFile(env, owner, { content: "result", conversationId: "conversation", fileName: "result", format: "text" });
    const generatedResponse = await proxyWorkspaceFile(env, owner, generated.file.objectId, "raw", new Request("http://localhost"));
    assert.equal(await generatedResponse.text(), "result");
    await assert.rejects(proxyWorkspaceFile(env, context, uploaded.file.objectId, "raw", new Request("http://localhost")), /mate_artifact_not_found/);
    const object = [...bucket.objects.values()].find((entry) => entry.options.customMetadata.artifactId === uploaded.file.objectId);
    assert.equal(object.options.customMetadata.userId, userId);
  }
});

test("storage failures are reported as attachment upload failures", async () => {
  const env = { MATE_ARTIFACTS: { async put() { throw new Error("storage temporarily unavailable"); } } };
  await assert.rejects(uploadWorkspaceAttachment(env, context, new File(["fixture"], "file.xlsx")),
    (error) => error.status === 502 && error.message === "workspace_attachment_upload_failed");
});

test("generated files stay in the current Mate and user's temporary workspace", async () => {
  const bucket = artifactBucket();
  const env = { MATE_ARTIFACTS: bucket };
  const result = await createWorkspaceFile(env, context, {
    content: "# Weekly summary\n", conversationId: "conversation-1", fileName: "weekly-summary", format: "markdown"
  });
  assert.equal(result.storage, "temporary");
  assert.equal(result.file.fileName, "weekly-summary.md");
  assert.match(result.file.previewUrl, /^\/api\/workspace-files\/art_/);
  const [key] = bucket.objects.keys();
  assert.match(key, /^mate-artifacts\/org\/example-org\/user\/user-1\/mate\/knowledge-access-local\/artifacts\/art_/);
  const response = await proxyWorkspaceFile(env, context, result.file.objectId, "raw", new Request("http://localhost"));
  assert.equal(await response.text(), "# Weekly summary\n");
  await assert.rejects(
    proxyWorkspaceFile(env, { ...context, user: { ...context.user, id: "other-user" } }, result.file.objectId, "raw", new Request("http://localhost")),
    /mate_artifact_not_found/
  );
});

test("generated HTML keeps its name and is not offered as an inline preview", async () => {
  const result = await createWorkspaceFile({ MATE_ARTIFACTS: artifactBucket() }, context, {
    content: "<!doctype html><title>季度汇报</title>", conversationId: "conversation-2", fileName: "示例企业季度汇报演示", format: "html"
  });
  assert.equal(result.file.fileName, "示例企业季度汇报演示.html");
  assert.equal(result.file.previewUrl, undefined);
});

test("same-name generated files get separate artifact IDs", async () => {
  const env = { MATE_ARTIFACTS: artifactBucket() };
  const input = { content: "hello", conversationId: "conversation-2", fileName: "report", format: "text" };
  const first = await createWorkspaceFile(env, context, input);
  const second = await createWorkspaceFile(env, context, input);
  assert.notEqual(first.file.objectId, second.file.objectId);
  assert.equal(env.MATE_ARTIFACTS.objects.size, 2);
});

test("uploaded attachments stay temporary and readable by the same Mate and user", async () => {
  const env = { MATE_ARTIFACTS: artifactBucket() };
  const result = await uploadWorkspaceAttachment(env, context, new File(["%PDF-test"], "quarterly-report.pdf", { type: "application/pdf" }));
  assert.equal(result.storage, "temporary");
  assert.equal(result.file.fileName, "quarterly-report.pdf");
  assert.match(result.file.rawUrl, /^\/api\/workspace-files\/art_/);
  assert.equal(result.file.downloadUrl, result.file.rawUrl.replace(/\/raw$/, "/download"));
  const response = await proxyWorkspaceFile(env, context, result.file.objectId, "raw", new Request("http://localhost"));
  assert.equal(await response.text(), "%PDF-test");
});

test("copying a temporary artifact into Knowledge uses the current user's ACL and chosen folder", async () => {
  const bucket = artifactBucket();
  const created = await uploadWorkspaceAttachment(
    { MATE_ARTIFACTS: bucket }, context,
    new File(["%PDF-test"], "quarterly-report.pdf", { type: "application/pdf" })
  );
  const result = await saveMateArtifactToKnowledge(
    { DEV_AUTH_BYPASS: "1", KNOWLEDGE_WORKER_URL: "http://knowledge.localhost", MATE_ARTIFACTS: bucket },
    context, created.file.objectId, "folder-target", {},
    { fetch: async (request) => {
      assert.equal(request.headers.get("x-workspace-user-id"), context.user.id);
      assert.equal(request.headers.get("x-workspace-scopes"), "workspace:knowledge:read,workspace:knowledge:write");
      const form = await request.formData();
      assert.equal(form.get("parentObjectId"), "folder-target");
      assert.equal(await form.get("file").text(), "%PDF-test");
      return Response.json({ item: { id: "kobj_saved", name: "quarterly-report.pdf", path: "Reports/quarterly-report.pdf" } });
    } }
  );
  assert.equal(result.knowledgeFile.objectId, "kobj_saved");
  assert.equal(result.knowledgeFile.path, "Reports/quarterly-report.pdf");
  await assert.rejects(
    saveMateArtifactToKnowledge({ MATE_ARTIFACTS: bucket }, { ...context, user: { ...context.user, id: "other-user" } }, created.file.objectId),
    /mate_artifact_not_found/
  );
});

test("saving requires a selected folder and permits a folder in the user's personal library", async () => {
  const bucket = artifactBucket();
  const created = await createWorkspaceFile({ MATE_ARTIFACTS: bucket }, context, {
    content: "# Report", conversationId: "conversation-1", fileName: "report.md", format: "markdown"
  });
  const paths = [];
  const deps = { fetch: async (request) => {
    const path = new URL(request.url).pathname;
    paths.push(`${request.method} ${path}`);
    if (path === "/api/tree") return Response.json({ namespace: { ownerUserId: context.user.id } });
    if (path === "/api/files/upload") {
      const form = await request.formData();
      assert.equal(form.get("parentObjectId"), "folder-reports");
      assert.equal(await form.get("file").text(), "# Report");
      return Response.json({ item: { id: "knowledge-report", name: "report.md", path: "Reports/report.md" } });
    }
    throw new Error(`Unexpected ${path}`);
  } };
  const env = { DEV_AUTH_BYPASS: "1", KNOWLEDGE_WORKER_URL: "http://knowledge.localhost", MATE_ARTIFACTS: bucket };
  await assert.rejects(saveMateArtifactToKnowledge(env, context, created.file.objectId, undefined, {}, deps), /knowledge_folder_id_required/);
  const first = await saveMateArtifactToKnowledge(env, context, created.file.objectId, "folder-reports", { folderEditScope: [] }, deps);
  const second = await saveMateArtifactToKnowledge(env, context, created.file.objectId, "folder-reports", {}, deps);
  assert.equal(first.knowledgeFile.path, "Reports/report.md");
  assert.equal(second.knowledgeFile.objectId, "knowledge-report");
  assert.equal(paths.filter((path) => path === "POST /api/folders").length, 0);
  await assert.rejects(
    saveMateArtifactToKnowledge(env, context, created.file.objectId, "other-folder", { folderEditScope: [] }, {
      fetch: async () => Response.json({ namespace: { ownerUserId: "other-user" } })
    }),
    /folder_edit_scope_required/
  );
});

test("Workspace file proxy keeps range support and read-only authorization", async () => {
  const env = {
    DEV_AUTH_BYPASS: "1",
    KNOWLEDGE_WORKER_URL: "http://knowledge.localhost"
  };
  const response = await proxyWorkspaceFile(
    env,
    context,
    "kobj_pdf",
    "raw",
    new Request("http://localhost/api/workspace-files/kobj_pdf/raw", {
      headers: { range: "bytes=0-3" }
    }),
    {
      fetch: async (request) => {
        assert.equal(request.headers.get("x-workspace-scopes"), "workspace:knowledge:read");
        assert.equal(request.headers.get("range"), "bytes=0-3");
        return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
          headers: {
            "content-range": "bytes 0-3/100",
            "content-type": "application/pdf"
          },
          status: 206
        });
      }
    }
  );

  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 0-3/100");
  assert.equal(response.headers.get("x-workspace-allow-same-origin-frame"), "1");
});

test('thumbnail access checks the same user/Mate ownership and expiry as original downloads', async () => {
  const bucket=artifactBucket(), calls=[];
  const env={MATE_ARTIFACTS:bucket,IMAGES:{input(stream){calls.push('transform');return {transform(){return this;},async output(){await new Response(stream).arrayBuffer();return {response:()=>new Response('thumb')};}};}}};
  const uploaded=await uploadWorkspaceAttachment(env,context,new File(['source-image'],'private.png',{type:'image/png'}));
  const url=new Request('https://runtime.test/thumbnail');
  assert.equal(await (await proxyWorkspaceFile(env,context,uploaded.file.objectId,'thumbnail',url)).text(),'thumb');
  const other={...context,user:{...context.user,id:'other'}};
  await assert.rejects(proxyWorkspaceFile(env,other,uploaded.file.objectId,'thumbnail',url),/mate_artifact_not_found/);
  await assert.rejects(proxyWorkspaceFile(env,{...context,appId:'other-mate'},uploaded.file.objectId,'thumbnail',url),/mate_artifact_not_found/);
  [...bucket.objects.values()][0].options.customMetadata.expiresAt='2000-01-01T00:00:00Z';
  await assert.rejects(proxyWorkspaceFile(env,context,uploaded.file.objectId,'thumbnail',url),/mate_artifact_not_found/);
  assert.equal(calls.length,1);
});
