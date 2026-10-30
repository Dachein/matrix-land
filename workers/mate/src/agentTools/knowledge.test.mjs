import assert from "node:assert/strict";
import test from "node:test";
import {
  knowledgeFileModelOutput,
  readKnowledgeFile,
  searchKnowledgeServices
} from "./knowledge.ts";

const env = {
  MATE_AUTH_SERVICE_TOKEN: "service-token",
  AUTH_WORKER_URL: "https://auth.example.test",
  KNOWLEDGE_PUBLIC_URL: "https://knowledge.example.test",
  KNOWLEDGE_WORKER_URL: "https://knowledge.example.test"
};
const context = {
  appCode: "knowledge-access",
  appId: "knowledge-access",
  description: "只读知识库 QA",
  displayName: "Knowledge Access Mate",
  exp: 2_000_000_000,
  iat: 1_900_000_000,
  user: { email: "user@example.test", id: "user-1", name: "User One" },
  version: 1
};

test("search only queries knowledge bases returned by the current ACL check", async () => {
  const calls = [];
  const fetch = async (request) => {
    calls.push(request.clone());
    const url = new URL(request.url);
    if (url.pathname === "/v1/resource-tokens/mint") {
      return Response.json({ access_token: "short-lived-resource-token" });
    }
    assert.equal(request.headers.get("authorization"), "Bearer short-lived-resource-token");
    if (url.pathname === "/api/knowledge-services") {
      return Response.json({ services: [
        {
          card: {
            bestFor: ["客户准入"],
            keywords: ["KYC"],
            notFor: ["员工福利"],
            role: "回答客户准入问题",
            searchHints: ["客户类型"]
          },
          description: "公开给用户的资料",
          name: "Visible KB",
          serviceId: "visible-kb"
        }
      ] });
    }
    if (url.pathname === "/api/knowledge-services/visible-kb/query") {
      const body = await request.json();
      assert.equal(body.action, "search");
      assert.equal(body.query, "客户准入");
      return Response.json({ results: [{
        fileName: "policy.md",
        objectId: "object-1",
        relativePath: "compliance/policy.md",
        snippet: "准入要求"
      }] });
    }
    throw new Error(`unexpected request: ${request.url}`);
  };

  const result = await searchKnowledgeServices(env, context, {
    limitPerService: 5,
    query: "客户准入",
    serviceIds: ["hidden-kb", "visible-kb"]
  }, {}, { fetch });

  assert.deepEqual(result.searchedServices, ["visible-kb"]);
  assert.equal(result.totalResults, 1);
  assert.equal(result.searches[0].service.role, "回答客户准入问题");
  assert.deepEqual(result.searches[0].service.bestFor, ["客户准入"]);
  assert.equal(calls.some((request) => request.url.includes("hidden-kb")), false);

  const mintRequests = calls.filter((request) => new URL(request.url).pathname === "/v1/resource-tokens/mint");
  assert.equal(mintRequests.length, 2);
  for (const request of mintRequests) {
    const body = await request.json();
    assert.deepEqual(body.principal, { sub: "user-1" });
    assert.deepEqual(body.scopes, ["workspace:knowledge:read"]);
    assert.equal(body.mcpBrokered, false);
  }
});

test("a selected knowledge base scope cannot expand to another visible base", async () => {
  const calls = [];
  const fetch = async (request) => {
    calls.push(request.clone());
    const url = new URL(request.url);
    if (url.pathname === "/v1/resource-tokens/mint") {
      return Response.json({ access_token: "short-lived-resource-token" });
    }
    if (url.pathname === "/api/knowledge-services") {
      return Response.json({ services: [
        { name: "Alpha", serviceId: "alpha" },
        { name: "Beta", serviceId: "beta" }
      ] });
    }
    if (url.pathname === "/api/knowledge-services/beta/query") {
      return Response.json({ results: [] });
    }
    throw new Error(`unexpected request: ${request.url}`);
  };

  const result = await searchKnowledgeServices(env, context, {
    limitPerService: 5,
    query: "范围测试",
    scopeServiceId: "beta",
    serviceIds: ["alpha", "beta"]
  }, {}, { fetch });

  assert.deepEqual(result.searchedServices, ["beta"]);
  assert.equal(calls.some((request) => request.url.includes("/alpha/query")), false);

  await assert.rejects(
    readKnowledgeFile(env, context, {
      objectId: "alpha-file",
      scopeServiceId: "beta",
      serviceId: "alpha"
    }, {}, { fetch }),
    (error) => error?.status === 403 && error?.message === "knowledge_base_outside_selected_scope"
  );
});

test("knowledge image read becomes a multimodal model input with citation metadata", async () => {
  const fetch = async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/v1/resource-tokens/mint") {
      return Response.json({ access_token: "short-lived-resource-token" });
    }
    return Response.json({
      content: {
        base64: "iVBORw0KGgo=",
        encoding: "base64",
        mimeType: "image/png",
        sizeBytes: 8
      },
      file: {
        fileName: "diagram.png",
        objectId: "image-1",
        relativePath: "design/diagram.png"
      }
    });
  };

  const result = await readKnowledgeFile(env, context, {
    objectId: "image-1",
    serviceId: "visible-kb"
  }, {}, { fetch });
  const modelOutput = knowledgeFileModelOutput(result);

  assert.equal(result.file.serviceId, "visible-kb");
  assert.equal(modelOutput.type, "content");
  assert.equal(modelOutput.value[0].type, "text");
  assert.match(modelOutput.value[0].text, /design\/diagram\.png/);
  assert.deepEqual(modelOutput.value[1], {
    data: { data: "iVBORw0KGgo=", type: "data" },
    filename: "diagram.png",
    mediaType: "image/png",
    type: "file"
  });
});

test("knowledge text read becomes a string tool result accepted by OpenAI-compatible models", () => {
  const modelOutput = knowledgeFileModelOutput({
    content: {
      encoding: "text",
      text: "大陆客户：最低资产要求以当前机构政策为准。"
    },
    file: {
      fileName: "ubs.md",
      objectId: "ubs-1",
      relativePath: "entities/ubs.md",
      serviceId: "pb-supply-chain"
    }
  });

  assert.equal(modelOutput.type, "text");
  assert.match(modelOutput.value, /Knowledge source:/);
  assert.match(modelOutput.value, /entities\/ubs\.md/);
  assert.match(modelOutput.value, /最低资产要求/);
});
