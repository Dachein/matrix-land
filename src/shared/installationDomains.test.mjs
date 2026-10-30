import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveInstallationDomains, installationDomainUrls, publicInstallationEndpoints } from "./installationDomains.ts";
import { canonicalMcpResource } from "./mcpResource.ts";

const input = { portalHostname: "workspace.example.com", serviceRoot: "example.net" };

test("separate enterprise roots retain stable service prefixes and permit exact overrides", () => {
  const first = resolveInstallationDomains(input);
  assert.equal(resolveInstallationDomains({ ...input, serviceRoot: "workspace.example.com" }).services.mcp, "mcp.workspace.example.com");
  const second = resolveInstallationDomains({ ...input, serviceRoot: "another.example", services: { mcp: "connector.example.org" } });
  assert.equal(first.services.auth, "auth.example.net");
  assert.equal(first.services.knowledge, "knowledge.example.net");
  assert.equal(first.appHostPrefix, "app-");
  assert.equal(second.services.auth, "auth.another.example");
  assert.equal(second.services.mcp, "connector.example.org");
  assert.equal(installationDomainUrls(first).portal, "https://workspace.example.com");
  assert.equal(first.serviceRoot, "example.net");
});

test("hostnames must be exact DNS names and service addresses cannot collide", () => {
  for (const value of ["*.example.com", "https://example.com", "a.example.com/path", "u@host.example", "127.0.0.1", "a..example", "-a.example", "localhost", "a.example:443"]) {
    assert.throws(() => resolveInstallationDomains({ ...input, serviceRoot: value }));
  }
  assert.throws(() => resolveInstallationDomains({ ...input, portalHostname: "auth.example.net" }), /collision/);
  assert.throws(() => resolveInstallationDomains({ ...input, services: { mcp: "auth.example.net" } }), /collision/);
  assert.throws(() => resolveInstallationDomains({ ...input, services: { mcp: "app-mcp.example.net" } }), /collision/);
  assert.throws(() => resolveInstallationDomains({ ...input, services: { toString: "a.example.net" } }), /invalid_service/);
});

test("MCP audiences never cross installations, even when a requested URL looks similar", () => {
  const configured = "https://mcp.example.net/mcp";
  for (const value of [undefined, "https://mcp.example.net", "https://mcp.example.net/mcp/"]) {
    assert.equal(canonicalMcpResource(value, configured), "https://mcp.example.net");
  }
  for (const value of ["https://mcp.example.invalid", "https://mcp.example.net.attacker.test", "https://user@mcp.example.net", "https://mcp.example.net/other", "https://mcp.example.net/mcp?x=1", "http://mcp.example.net"]) {
    assert.equal(canonicalMcpResource(value, configured), undefined);
  }
  assert.equal(canonicalMcpResource(undefined, undefined), undefined);
});

test("public endpoints omit credentials and leave unconfigured domains absent", () => {
  assert.deepEqual(publicInstallationEndpoints({ CF_API_TOKEN: "secret" }), {});
  assert.deepEqual(publicInstallationEndpoints({ APPS_BASE_DOMAIN: "example.net", APPS_APP_HOST_PREFIX: "app-", MCP_RESOURCE_URL: "https://mcp.example.net", CF_API_TOKEN: "secret" }), {
    appBaseDomain: "example.net", appHostPrefix: "app-", mcpUrl: "https://mcp.example.net"
  });
});
