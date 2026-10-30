import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../dist/", import.meta.url);
const app = JSON.parse(readFileSync(new URL("app.json", root), "utf8"));
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const expectedPages = ["pages/chat/index", "pages/mates/index", "pages/mate-settings/index", "pages/knowledge/index", "pages/knowledge-preview/index", "pages/file-import/index"];
const expectedMaterials = ["application/*", "text/plain", "text/html", "text/markdown", "image/*"];

for (const page of expectedPages) {
  assert(app.pages.includes(page), `Package is missing page ${page}`);
  assert(statSync(new URL(`${page}.js`, root)).isFile(), `Package is missing ${page}.js`);
}
for (const materialType of expectedMaterials) {
  assert(app.supportedMaterials?.some((material) => material.materialType === materialType && material.path === "pages/file-import/index"), `Package is missing material type ${materialType}`);
}
assert.equal(app.window.navigationBarTitleText, "工作区 AI");

function collect(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? collect(path) : /\.(?:js|json|wxss)$/.test(name) ? [readFileSync(path, "utf8")] : [];
  });
}

const bundle = collect(root.pathname).join("\n").replace(/\\u([0-9a-f]{4})/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
for (const [feature, marker] of Object.entries({
  localizedTitle: "工作区 AI",
  firstMateGuide: "开启你的专属数字助理",
  firstMateProgress: "正在发布 Mate",
  chatContinuation: "chat-continuation",
  keyboardViewport: "keyboard-open",
  boundedComposer: "composer-input-shell",
  inlineImages: "chat-image-preview",
  nativeImages: "previewImage",
  uploadProgress: "文件上传中",
  compactTranscript: "transcriptMode",
  historyPagination: "x-workspace-chat-next-cursor",
  approvalResults: "执行结果暂时无法加载",
  knowledgeSave: "knowledge-folder-picker",
  partialUploadRetry: "重试失败的附件",
  mateSettings: "mate-menu-settings",
  menuFooter: "mate-menu-version",
  createMateInChat: "mate-create-panel",
  knowledgeHome: "knowledge-library/home",
  knowledgeFolder: "knowledge-library/folders/",
  knowledgeUnifiedList: "knowledge-list-group",
  knowledgePreview: "knowledge-preview-page",
  pdfPreview: "openDocument",
  richFilePreview: "knowledge-preview-rich",
  htmlFilePreview: "text/html",
  officeFileShare: "shareFileMessage",
  knowledgeMenu: "knowledge-menu-trigger",
  logout: "退出登录",
  languageSwitch: "简体中文",
  version,
  fileImport: "保存到知识库"
})) {
  assert(bundle.includes(marker), `Package is missing ${feature}: ${marker}`);
}
assert(!bundle.includes("Hello, {name}"), "Package still contains the removed home greeting");
assert(!bundle.includes("first-mate-provisioning-help"), "Package still contains the removed overlapping setup hint");
assert(!bundle.includes("修改相关配置，请登录 ai.example.invalid"), "Package still contains the removed configuration hint");
assert(!bundle.includes("knowledge-section-title"), "Package still contains the discarded knowledge card layout");
const icon = readFileSync(new URL("../src/assets/book-open.png", import.meta.url));
assert(bundle.includes(icon.toString("base64")), "Package is missing the knowledge icon");

console.log(`Verified miniapp package ${version}: ${expectedPages.length} pages, ${expectedMaterials.length} file types, navigation and onboarding`);
