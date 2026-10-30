import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { describe, it } from "node:test";

import mokaConnectorWorker from "../../connectors/moka/src/index.ts";
import {
  canonicalMokaParams,
  mokaConfigurationStatus,
  queryMokaDepartments,
  queryMokaEmployeeByOfficeEmail,
  queryMokaEmployees,
  signMokaParams
} from "../../connectors/moka/src/moka.ts";

function createFixture(emailPolicy = { mode: "company_email_only", allowedDomains: ["example.test"] }) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
  return {
    env: {
      AUTH_DB: {
        prepare() {
          return {
            bind() {
              return {
                async first() {
                  return {
                    allowed_domains_json: JSON.stringify(emailPolicy.allowedDomains),
                    mode: emailPolicy.mode,
                    updated_at: "2026-09-30 00:00:00",
                    updated_by_user_id: "admin-1"
                  };
                }
              };
            }
          };
        }
      },
      MOKA_CONNECTOR_SERVICE_TOKEN: "test-moka-connector-service-token",
      MOKA_API_KEY: "moka-api-key",
      MOKA_DEPARTMENT_API_CODE: "department-api-code",
      MOKA_EMPLOYEE_API_CODE: "employee-api-code",
      MOKA_ENABLED: "1",
      MOKA_ENT_CODE: "tenant-code",
      MOKA_PRIVATE_KEY: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      MOKA_PUBLIC_HOST: "moka-public.example.test",
      MOKA_WEBHOOK_SECRET: "webhook-secret-at-least-32-characters",
      MOKA_USER_NAME: "moka-admin@example.test"
    },
    publicKey
  };
}

function assertSignedRequest(url, publicKey, expected) {
  const params = Object.fromEntries(url.searchParams.entries());
  const signature = params.sign;
  delete params.sign;
  assert.deepEqual(params, expected);

  const verifier = createVerify("RSA-MD5");
  verifier.update(canonicalMokaParams(params), "utf8");
  verifier.end();
  assert.equal(verifier.verify(publicKey, signature, "base64"), true);
}

describe("Moka People client", () => {
  it("canonicalizes and signs query parameters with RSA-MD5", () => {
    const { env, publicKey } = createFixture();
    const params = {
      timestamp: "1661404684195",
      nonce: "zct0ygn1",
      entCode: "tenant-code",
      apiCode: "department-api-code"
    };

    assert.equal(
      canonicalMokaParams(params),
      "apiCode=department-api-code&entCode=tenant-code&nonce=zct0ygn1&timestamp=1661404684195"
    );
    const verifier = createVerify("RSA-MD5");
    verifier.update(canonicalMokaParams(params), "utf8");
    verifier.end();
    assert.equal(verifier.verify(publicKey, signMokaParams(env.MOKA_PRIVATE_KEY, params), "base64"), true);
  });

  it("queries the department endpoint without exposing credentials", async () => {
    const { env, publicKey } = createFixture();
    let request;
    const result = await queryMokaDepartments(env, {
      haveUsed: 1,
      nodeCodeList: ["D-100"],
      pageNum: 2,
      pageSize: 50
    }, {
      now: () => 1661404684195,
      nonce: () => "zct0ygn1",
      fetcher: async (url, init) => {
        request = { url: new URL(url), init };
        return new Response(JSON.stringify({ code: 200, msg: "操作成功", data: { list: [], total: 0 } }));
      }
    });

    assert.equal(request.url.pathname, "/api-platform/hcm/oapi/v1/org/department/batchData");
    assertSignedRequest(request.url, publicKey, {
      apiCode: "department-api-code",
      entCode: "tenant-code",
      nonce: "zct0ygn1",
      timestamp: "1661404684195"
    });
    assert.equal(request.init.headers.Authorization, `Basic ${Buffer.from("moka-api-key:").toString("base64")}`);
    assert.deepEqual(JSON.parse(request.init.body), {
      pageSize: 50,
      pageNum: 2,
      nodeUidList: [],
      nodeCodeList: ["D-100"],
      haveUsed: 1
    });
    assert.equal(result.data.total, 0);
  });

  it("queries employees with the permission-bearing user name in the signature", async () => {
    const { env, publicKey } = createFixture();
    let requestUrl;
    let requestBody;
    await queryMokaEmployees(env, {
      officeEmailList: ["employee@example.test"],
      pageSize: 200
    }, {
      now: () => 1661404684195,
      nonce: () => "zct0ygn1",
      fetcher: async (url, init) => {
        requestUrl = new URL(url);
        requestBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ code: "200", msg: "操作成功", data: { list: [{ uuid: 123 }] } }));
      }
    });

    assert.equal(requestUrl.pathname, "/api-platform/hcm/oapi/v1/batch/data");
    assertSignedRequest(requestUrl, publicKey, {
      apiCode: "employee-api-code",
      entCode: "tenant-code",
      nonce: "zct0ygn1",
      timestamp: "1661404684195",
      userName: "moka-admin@example.test"
    });
    assert.deepEqual(requestBody.officeEmailList, ["employee@example.test"]);
  });

  it("resolves exactly one employee by normalized work email with private source links", async () => {
    const { env } = createFixture();
    let requestBody;
    const employee = await queryMokaEmployeeByOfficeEmail(env, "  PERSON@EXAMPLE.TEST ", {
      fetcher: async (_url, init) => {
        requestBody = JSON.parse(init.body);
        return new Response(JSON.stringify({
          code: 200,
          data: {
            list: [{
              department: { name: "AI Adoption" },
              employee_no: "F001",
              employee_status: "在职",
              employee_status_id: 1,
              office_email: "Person@Example.Test",
              position: { name: "Engineer" },
              realname: "Person Example",
              uuid: 987654
            }],
            total: 1
          },
          msg: "操作成功"
        }));
      }
    });

    assert.deepEqual(requestBody.officeEmailList, ["person@example.test"]);
    assert.deepEqual(employee, {
      active: true,
      department: "AI Adoption",
      departmentExternalId: undefined,
      duty: undefined,
      email: "person@example.test",
      employeeNo: "F001",
      employmentStatus: "在职",
      employmentStatusId: 1,
      externalId: "987654",
      jobTitle: "Engineer",
      name: "Person Example",
      path: ["AI Adoption"],
      position: "Engineer",
      source: "moka"
    });
    assert.equal("uuid" in employee, false);
  });

  it("fails explicitly when an email is missing or duplicated", async () => {
    const { env } = createFixture();
    await assert.rejects(
      queryMokaEmployeeByOfficeEmail(env, "not-an-email"),
      { status: 400, code: "invalid_moka_employee_email" }
    );

    await assert.rejects(
      queryMokaEmployeeByOfficeEmail(env, "duplicate@example.test", {
        fetcher: async () => new Response(JSON.stringify({
          code: 200,
          data: {
            list: [
              { office_email: "duplicate@example.test" },
              { office_email: "DUPLICATE@example.test" }
            ],
            total: 2
          }
        }))
      }),
      { status: 409, code: "moka_employee_email_conflict" }
    );

    await assert.rejects(
      queryMokaEmployeeByOfficeEmail(env, "missing@example.test", {
        fetcher: async () => new Response(JSON.stringify({ code: 200, data: { list: [], total: 0 } }))
      }),
      { status: 404, code: "moka_employee_not_found" }
    );
  });

  it("offers a service-token-protected email lookup route", async () => {
    const { env } = createFixture();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      code: 200,
      data: {
        list: [{
          employee_status: "在职",
          employee_status_id: 1,
          office_email: "employee@example.test",
          realname: "Employee",
          uuid: 123
        }],
        total: 1
      }
    }));

    try {
      const response = await mokaConnectorWorker.fetch(new Request(
        "https://moka-connector.example.test/v1/employees/by-email",
        {
          body: JSON.stringify({ email: "EMPLOYEE@example.test" }),
          headers: {
            Authorization: "Bearer test-moka-connector-service-token",
            "Content-Type": "application/json"
          },
          method: "POST"
        }
      ), env);
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(payload.employee.email, "employee@example.test");
      assert.equal(payload.employee.active, true);
      assert.equal(JSON.stringify(payload).includes("uuid"), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("filters the Moka directory inside the Connector using the shared Auth email policy", async () => {
    const { env } = createFixture();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      code: 200,
      data: {
        list: [
          { employee_status: "在职", employee_status_id: 1, office_email: "person@example.test", realname: "Person", uuid: 123 },
          { employee_status: "在职", employee_status_id: 1, office_email: "personal@gmail.com", realname: "Personal", uuid: 456 },
          { employee_status: "在职", employee_status_id: 1, realname: "No Mailbox", uuid: 789 }
        ],
        total: 3
      }
    }));

    try {
      const response = await mokaConnectorWorker.fetch(new Request(
        "https://moka-connector.example.test/v1/directory/employees",
        { headers: { Authorization: `Bearer ${env.MOKA_CONNECTOR_SERVICE_TOKEN}` }, method: "POST" }
      ), env);
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.filteredCount, 1);
      assert.deepEqual(payload.employees.map((employee) => employee.email), ["person@example.test", ""]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not filter Moka employees by domain when the shared policy is open", async () => {
    const { env } = createFixture({ mode: "open", allowedDomains: ["example.test"] });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      code: 200,
      data: {
        list: [
          { employee_status: "在职", employee_status_id: 1, office_email: "person@example.test", realname: "Person", uuid: 123 },
          { employee_status: "在职", employee_status_id: 1, office_email: "personal@gmail.com", realname: "Personal", uuid: 456 }
        ],
        total: 2
      }
    }));

    try {
      const response = await mokaConnectorWorker.fetch(new Request(
        "https://moka-connector.example.test/v1/directory/employees",
        { headers: { Authorization: `Bearer ${env.MOKA_CONNECTOR_SERVICE_TOKEN}` }, method: "POST" }
      ), env);
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.filteredCount, 0);
      assert.deepEqual(payload.employees.map((employee) => employee.email), ["person@example.test", "personal@gmail.com"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not return a non-allowlisted employee from Connector ID lookup", async () => {
    const { env } = createFixture();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      code: 200,
      data: { list: [{ employee_status: "在职", employee_status_id: 1, office_email: "personal@gmail.com", realname: "Personal", uuid: 456 }], total: 1 }
    }));

    try {
      const response = await mokaConnectorWorker.fetch(new Request(
        "https://moka-connector.example.test/v1/employees/by-id",
        {
          body: JSON.stringify({ employeeId: "456" }),
          headers: { Authorization: `Bearer ${env.MOKA_CONNECTOR_SERVICE_TOKEN}`, "Content-Type": "application/json" },
          method: "POST"
        }
      ), env);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).filtered, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accepts authenticated Moka GET webhooks and only exposes the webhook route publicly", async () => {
    const { env } = createFixture();
    const events = [];
    env.MOKA_DIRECTORY_EVENTS = {
      async send(event, options) { events.push({ event, options }); }
    };
    const query = new URLSearchParams({
      apiCode: env.MOKA_EMPLOYEE_API_CODE,
      employeeId: "1731630",
      modifyType: "3",
      pwd: env.MOKA_WEBHOOK_SECRET,
      sourceType: "1",
      ts: "1661404684195"
    });
    const response = await mokaConnectorWorker.fetch(new Request(
      `https://moka-public.example.test/webhooks/v1/events?${query}`
    ), env);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { code: "200", data: "", msg: "success" });
    assert.deepEqual(events, [{
      event: {
        action: "update",
        apiCode: env.MOKA_EMPLOYEE_API_CODE,
        entityType: "employee",
        eventKey: "1:3:1731630:1661404684195",
        occurredAt: "1661404684195",
        receivedAt: events[0].event.receivedAt,
        sourceId: "1731630",
        sourceType: "1"
      },
      options: { contentType: "json" }
    }]);

    const internalRoute = await mokaConnectorWorker.fetch(new Request(
      "https://moka-public.example.test/v1/status",
      { headers: { Authorization: `Bearer ${env.MOKA_CONNECTOR_SERVICE_TOKEN}` } }
    ), env);
    assert.equal(internalRoute.status, 404);
  });

  it("accepts the documented department callback without a synthetic event key or timestamp", async () => {
    const { env } = createFixture();
    const events = [];
    env.MOKA_DIRECTORY_EVENTS = {
      async send(event) { events.push(event); }
    };
    const query = new URLSearchParams({
      apiCode: env.MOKA_DEPARTMENT_API_CODE,
      modifyType: "3",
      nodeUid: "1365705",
      pwd: env.MOKA_WEBHOOK_SECRET,
      sourceType: "2"
    });

    const response = await mokaConnectorWorker.fetch(new Request(
      `https://moka-public.example.test/webhooks/v1/events?${query}`
    ), env);

    assert.equal(response.status, 200);
    assert.equal(events.length, 1);
    assert.deepEqual({
      action: events[0].action,
      entityType: events[0].entityType,
      occurredAt: events[0].occurredAt,
      sourceId: events[0].sourceId,
      sourceType: events[0].sourceType
    }, {
      action: "update",
      entityType: "department",
      occurredAt: undefined,
      sourceId: "1365705",
      sourceType: "2"
    });
    assert.match(events[0].eventKey, /^[0-9a-f-]{36}$/i);
  });

  it("rejects Moka webhooks with an invalid shared secret", async () => {
    const { env } = createFixture();
    env.MOKA_DIRECTORY_EVENTS = { async send() { throw new Error("must not enqueue"); } };
    const response = await mokaConnectorWorker.fetch(new Request(
      `https://moka-public.example.test/webhooks/v1/events?${new URLSearchParams({
        apiCode: env.MOKA_DEPARTMENT_API_CODE,
        modifyType: "1",
        nodeUid: "1365705",
        pwd: "wrong",
        sourceType: "2"
      })}`
    ), env);
    assert.equal(response.status, 401);
  });

  it("fails closed when disabled and validates conflicting department filters", async () => {
    const { env } = createFixture();
    await assert.rejects(
      queryMokaDepartments({ ...env, MOKA_ENABLED: "0" }),
      { status: 503, code: "moka_integration_disabled" }
    );
    await assert.rejects(
      queryMokaDepartments(env, { nodeCodeList: ["D-1"], nodeUidList: [1] }),
      { status: 400, code: "moka_department_filter_conflict" }
    );
  });

  it("reports readiness without returning secret values", () => {
    const { env } = createFixture();
    const status = mokaConfigurationStatus(env);
    assert.deepEqual(status.missing, []);
    assert.equal(status.configured, true);
    assert.equal(status.enabled, true);
    assert.equal(JSON.stringify(status).includes(env.MOKA_API_KEY), false);
    assert.equal(JSON.stringify(status).includes(env.MOKA_PRIVATE_KEY), false);
  });

  it("exposes service-token-protected read-only connector routes", async () => {
    const { env } = createFixture();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      code: 200,
      msg: "操作成功",
      data: { list: [{ node_uid: 101 }], total: 1 }
    }));

    try {
      const response = await mokaConnectorWorker.fetch(new Request("https://moka-connector.example.test/v1/departments/query", {
        body: JSON.stringify({ pageNum: 1, pageSize: 200 }),
        headers: {
          Authorization: "Bearer test-moka-connector-service-token",
          "Content-Type": "application/json"
        },
        method: "POST"
      }), env);
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Cache-Control"), "private, no-store");
      assert.equal(payload.source, "moka");
      assert.equal(payload.data.list[0].node_uid, 101);
      assert.equal(typeof payload.requestId, "string");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects connector reads without the dedicated connector token", async () => {
    const { env } = createFixture();
    const response = await mokaConnectorWorker.fetch(new Request(
      "https://moka-connector.example.test/v1/status"
    ), env);
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.equal(payload.error, "invalid_moka_connector_service_token");
  });
});
