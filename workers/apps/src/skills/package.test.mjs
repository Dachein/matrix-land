import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

let packageModulePromise;

async function loadPackageModule() {
  const outdir = await mkdtemp(join(tmpdir(), "apps-skill-package-test-"));
  const outfile = join(outdir, "package.mjs");
  await build({
    bundle: true,
    entryPoints: [new URL("./package.ts", import.meta.url).pathname],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

function packageModule() {
  packageModulePromise ??= loadPackageModule();
  return packageModulePromise;
}

const skillMarkdown = `---
name: Research Skill
description: Summarizes internal research.
version: 1.2.3
---

# Research Skill

Use approved internal sources only.
`;

describe("APPS Skill package utilities", () => {
  it("normalizes SKILL.md-only packages and reports the lightweight-package warning", async () => {
    const { validateSkillPackage } = await packageModule();
    const validated = validateSkillPackage({ skillMarkdown });

    assert.equal(validated.ok, true);
    assert.equal(validated.slug, "research-skill");
    assert.equal(validated.frontmatter.name, "Research Skill");
    assert.deepEqual(validated.files.map((file) => file.path), ["SKILL.md"]);
    assert.deepEqual(validated.warnings, ["Package contains only SKILL.md. Use a folder package for references/scripts/assets."]);
  });

  it("adds pintail manifest structure and creates a downloadable zip payload", async () => {
    const {
      buildPintailManifest,
      canonicalSkillFiles,
      createZip,
      sha256Bytes,
      validateSkillPackage,
      withSkillPackageStructure
    } = await packageModule();
    const validated = validateSkillPackage({
      skillMarkdown,
      files: [
        {
          path: "references/source-notes.md",
          content: "Approved source notes."
        }
      ]
    });
    const baseManifest = buildPintailManifest({
      capabilities: ["research"],
      description: "Summarizes internal research.",
      kind: "vanilla",
      name: "Research Skill",
      orgSlug: "workspace-wealth",
      slug: validated.slug,
      version: "1.2.3"
    });
    const manifest = withSkillPackageStructure(
      baseManifest,
      canonicalSkillFiles(validated.files, validated.skillMarkdown, baseManifest)
    );
    const files = canonicalSkillFiles(validated.files, validated.skillMarkdown, manifest);
    const zipBytes = createZip(files);
    const zipText = Buffer.from(zipBytes).toString("utf8");
    const digest = await sha256Bytes(zipBytes);

    assert.equal(manifest.schemaVersion, "pintail.skill.v1");
    assert.equal(manifest.package.fileCount, 3);
    assert.equal(manifest.package.sourceFileCount, 2);
    assert.deepEqual(manifest.package.files.map((file) => file.path).sort(), ["SKILL.md", "references/source-notes.md"]);
    assert.deepEqual(files.map((file) => file.path).sort(), ["SKILL.md", "pintail.json", "references/source-notes.md"]);
    assert.equal(zipBytes[0], 0x50);
    assert.equal(zipBytes[1], 0x4b);
    assert.match(zipText, /SKILL\.md/);
    assert.match(zipText, /pintail\.json/);
    assert.match(zipText, /references\/source-notes\.md/);
    assert.match(digest, /^[a-f0-9]{64}$/);
  });

  it("rejects unsafe package paths before zip creation", async () => {
    const { validateSkillPackage } = await packageModule();

    for (const path of ["../secret.md", "references/../secret.md", "references/..", "/absolute.md", "references//notes.md"]) {
      assert.throws(
        () => validateSkillPackage({
          skillMarkdown,
          files: [{ path, content: "nope" }]
        }),
        (error) => error.status === 400 && error.code === "invalid_skill_file_path"
      );
    }
  });
});
