import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasValidPublicationCoverImage,
  normalizeAppReviewMetadata,
  normalizeAssetLifecycleStatus,
  normalizeAssetRiskLevel,
  normalizePublicationArtifactType,
  normalizePublicationVisibility,
  normalizeSensitiveDataTypes,
  normalizeStringList,
  normalizeTargetPlane,
  normalizeUnknownObject,
  normalizeVersion
} from "./normalizers.ts";

function makeDeps(overrides = {}) {
  return {
    assertHttpUrl(value, errorCode) {
      try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          throw new Error(errorCode);
        }
        return url;
      } catch {
        throw Object.assign(new Error(errorCode), { status: 400 });
      }
    },
    normalizeAssetImageUrl(value) {
      const text = String(value ?? "").trim();
      return text.startsWith("/assets/") ? text : "";
    },
    optionalText(value, maxLength) {
      return String(value ?? "").trim().slice(0, maxLength);
    },
    requireText(value, errorCode, maxLength) {
      const text = String(value ?? "").trim();
      if (!text) {
        throw Object.assign(new Error(errorCode), { status: 400 });
      }
      return text.slice(0, maxLength);
    },
    ...overrides
  };
}

describe("publication normalizers", () => {
  it("normalizes lifecycle, risk, visibility, and target plane fallbacks", () => {
    assert.equal(normalizeAssetLifecycleStatus("listed"), "listed");
    assert.equal(normalizeAssetLifecycleStatus("unknown"), "pending_review");
    assert.equal(normalizeAssetRiskLevel("medium"), "medium");
    assert.equal(normalizeAssetRiskLevel("critical"), "low");
    assert.equal(normalizePublicationVisibility("private"), "private");
    assert.equal(normalizePublicationVisibility("public"), "org");
    assert.equal(normalizeTargetPlane("portal"), "portal");
    assert.equal(normalizeTargetPlane("anything"), "apps");
  });

  it("uses target-specific artifact fallbacks", () => {
    assert.equal(normalizePublicationArtifactType(undefined, "app"), "app_config");
    assert.equal(normalizePublicationArtifactType(undefined, "skill"), "package");
    assert.equal(normalizePublicationArtifactType("document", "skill"), "document");
    assert.equal(normalizeVersion("2.3.4-beta.1"), "2.3.4-beta.1");
    assert.equal(normalizeVersion("not-a-version"), "1.0.0");
  });

  it("dedupes string lists and filters sensitive data types", () => {
    assert.deepEqual(normalizeStringList([" alpha ", "alpha", "beta-long".repeat(40), ""], 3, 8), ["alpha", "beta-lon"]);
    assert.deepEqual(normalizeSensitiveDataTypes([
      "customer_information",
      "unsupported",
      "financial_information"
    ]), ["customer_information", "financial_information"]);
  });

  it("parses object JSON and drops arrays for object-shaped fields", () => {
    assert.deepEqual(normalizeUnknownObject("{\"source\":\"apps\"}"), { source: "apps" });
    assert.deepEqual(normalizeUnknownObject("[1,2]"), {});
    assert.deepEqual(normalizeUnknownObject({ source: "portal" }), { source: "portal" });
  });

  it("accepts only supported publication cover URL shapes", () => {
    assert.equal(hasValidPublicationCoverImage("/assets/cover.png"), true);
    assert.equal(hasValidPublicationCoverImage("/api/forum/media/covers%2Fcover.png"), true);
    assert.equal(hasValidPublicationCoverImage("https://cdn.example.com/cover.webp"), true);
    assert.equal(hasValidPublicationCoverImage("data:image/png;base64,aGVsbG8="), true);
    assert.equal(hasValidPublicationCoverImage(""), false);
    assert.equal(hasValidPublicationCoverImage("javascript:alert(1)"), false);
    assert.equal(hasValidPublicationCoverImage("not a URL"), false);
  });

  it("normalizes app review metadata with injected URL and image rules", () => {
    const metadata = normalizeAppReviewMetadata({
      nameZh: "  财富助手  ",
      subtitle: "智能投研",
      descriptionEn: "English description",
      launchUrl: "https://app.example.com/start",
      callbackUrl: "https://app.example.com/callback",
      coverImageUrl: "/assets/cover.png",
      accessMode: "targeted",
      accessTargets: ["management", "management", "finance"],
      deploymentProvider: "vercel",
      deploymentMethod: "docker",
      dataRegion: "singapore",
      dataTypes: "[\"portfolio\",\"risk\"]",
      sensitiveDataTypes: "[\"customer_information\",\"unknown\"]",
      knowledgeSources: ["policy", "market"],
      usesWorkspaceAuth: true
    }, makeDeps());

    assert.equal(metadata.name, "财富助手");
    assert.equal(metadata.description, "English description");
    assert.equal(metadata.launchUrl, "https://app.example.com/start");
    assert.equal(metadata.callbackUrl, "https://app.example.com/callback");
    assert.deepEqual(metadata.screenshots, ["/assets/cover.png"]);
    assert.equal(metadata.accessMode, "targeted");
    assert.equal(metadata.userScope, "custom");
    assert.deepEqual(metadata.accessTargets, ["management", "finance"]);
    assert.equal(metadata.deploymentProvider, "vercel");
    assert.equal(metadata.deploymentMethod, "docker");
    assert.equal(metadata.dataRegion, "singapore");
    assert.deepEqual(metadata.dataTypes, ["portfolio", "risk"]);
    assert.deepEqual(metadata.sensitiveDataTypes, ["customer_information"]);
    assert.equal(metadata.usesWorkspaceAuth, true);
  });

  it("requires a valid launch URL for app review metadata", () => {
    assert.throws(
      () => normalizeAppReviewMetadata({
        subtitle: "Missing URL",
        description: "Description",
        launchUrl: "ftp://example.com"
      }, makeDeps()),
      (error) => error.status === 400 && error.message === "invalid_launch_url"
    );
  });
});
