import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { build } from "esbuild";
import { groupConversationDirectoryItems } from "./directoryOrdering.ts";
import { mateDirectoryCacheKey } from "./directoryCache.ts";

const items = [
  { id: "recent-new", title: "普通新对话", pinned: false, status: "active", updatedAt: "2026-10-08T12:00:00Z" },
  { id: "pinned-old", title: "置顶旧对话", pinned: true, status: "active", updatedAt: "2026-10-06T12:00:00Z" },
  { id: "recent-old", title: "普通旧对话", pinned: false, status: "active", updatedAt: "2026-10-07T12:00:00Z" },
  { id: "pinned-new", title: "置顶新对话", pinned: true, status: "active", updatedAt: "2026-10-07T18:00:00Z" },
  { id: "archived", title: "存档对话", pinned: true, status: "archived", updatedAt: "2026-10-08T18:00:00Z" }
];
const session = { principalKey: "test-user", mode: "live", mate: { id: "test-mate" }, release: { id: "test-release" },
  conversationId: "draft", conversationState: "draft", surface: { entries: [{ kind: "conversation", channel: "sdk" }] } };

describe("conversation pin ordering and summary groups", () => {
  it("puts only active pins first, orders each group, and preserves the source page", () => {
    const before = structuredClone(items);
    const groups = groupConversationDirectoryItems(items);
    assert.deepEqual(groups.active.map((item) => item.id), ["pinned-new", "pinned-old", "recent-new", "recent-old"]);
    assert.deepEqual(groups.archived.map((item) => item.id), ["archived"]);
    assert.deepEqual(items, before);
  });

  it("renders separate pinned and recent sections with one leading icon per row", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workspace-directory-summary-"));
    const outfile = join(directory, "summary.mjs");
    await build({
      stdin: { contents: `import { createElement } from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { StandaloneNavigation } from './components/StandaloneNavigation';
        export function render(props) { return renderToStaticMarkup(createElement(StandaloneNavigation, props)); }`,
        loader: "tsx", resolveDir: new URL(".", import.meta.url).pathname },
      bundle: true, format: "esm", platform: "node", target: "node20", outfile, logLevel: "silent",
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }
    });
    const previousWindow = globalThis.window;
    const key = mateDirectoryCacheKey(session, "conversations");
    let cached = items;
    globalThis.window = { localStorage: { getItem: (requested) => requested === key ? JSON.stringify({ items: cached, updatedAt: Date.now() }) : null } };
    try {
      const { render } = await import(pathToFileURL(outfile).href);
      const props = { session, entry: session.surface.entries[0], portalSummary: true, directoryTitles: {},
        directoryRevision: 0, conversationActionError: "", clearingPreview: false, switchingConversationId: "", textSize: "standard" };
      const html = render(props);
      const pinned = html.match(/<section[^>]*aria-label="置顶对话"[^>]*>([\s\S]*?)<\/section>/)?.[1];
      const recent = html.match(/<section[^>]*aria-label="最近对话"[^>]*>([\s\S]*?)<\/section>/)?.[1];
      assert.ok(pinned && recent);
      assert.ok(html.indexOf(pinned) < html.indexOf(recent));
      assert.ok(pinned.indexOf("置顶新对话") < pinned.indexOf("置顶旧对话"));
      assert.ok(!pinned.includes("普通") && !pinned.includes("存档对话"));
      assert.equal((pinned.match(/lucide-pin\b/g) ?? []).length, 2);
      assert.ok(!pinned.includes("lucide-message-square-text"));
      assert.ok(recent.includes("普通新对话") && recent.includes("普通旧对话"));
      assert.ok(recent.includes("最近") && !recent.includes("lucide-pin"));
      assert.equal((recent.match(/lucide-message-square-text/g) ?? []).length, 2);
      cached = items.filter((item) => !item.pinned);
      assert.ok(!render(props).includes('aria-label="置顶对话"'));
    } finally {
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
