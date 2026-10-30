import type { Env, ObjectRow, VersionRow } from "../types.ts";
import { requireCurrentVersion } from "../objects/repository.ts";
import { HttpError, html } from "../http.ts";
import { effectiveKnowledgePolicy } from "../policy.ts";
import { contentTypeFromName } from "../objects/content.ts";
import { parseCsvPreview } from "../../../../src/shared/filePreview.ts";
import { renderMarkdown } from "../../../../src/shared/markdownRenderer.ts";
import { bytesToBase64 } from "../values.ts";

export async function rawObjectResponse(
  env: Env,
  object: ObjectRow,
  request: Request,
  options: { disposition: "inline" | "attachment"; cacheControl: string }
) {
  const version = await requireCurrentVersion(env, object);
  const rangeHeader = request.headers.get("Range");
  const byteRange = parseByteRange(rangeHeader, version.size_bytes);

  if (rangeHeader && !byteRange) {
    return new Response(null, {
      status: 416,
      headers: {
        "Content-Range": `bytes */${version.size_bytes}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": options.cacheControl
      }
    });
  }

  const r2Object = byteRange
    ? await env.KNOWLEDGE_OBJECTS.get(version.r2_key, { range: { offset: byteRange.start, length: byteRange.length } })
    : await env.KNOWLEDGE_OBJECTS.get(version.r2_key);
  if (!r2Object) {
    throw new HttpError(404, "r2_object_not_found");
  }

  const headers = new Headers();
  headers.set("Content-Type", version.mime_type || object.mime_type || "application/octet-stream");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", options.cacheControl);
  headers.set("Content-Disposition", `${options.disposition}; filename="${safeDownloadName(object.file_name)}"`);
  const etag = `"${version.sha256 || version.id}"`;
  headers.set("ETag", etag);
  if (!byteRange && request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  if (byteRange) {
    headers.set("Content-Range", `bytes ${byteRange.start}-${byteRange.end}/${version.size_bytes}`);
    headers.set("Content-Length", String(byteRange.length));
    return new Response(r2Object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(version.size_bytes));
  return new Response(r2Object.body, { headers });
}

function parseByteRange(header: string | null, totalSize: number) {
  if (!header) return null;
  const match = header.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match || totalSize < 1) return null;

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;

  let start: number;
  let end: number;
  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(totalSize - suffixLength, 0);
    end = totalSize - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : totalSize - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    end = Math.min(end, totalSize - 1);
  }

  if (start < 0 || start >= totalSize || end < start) return null;
  return { start, end, length: end - start + 1 };
}

type ViewerOptions = {
  rawUrl?: string;
  cacheControl: string;
  embedded: boolean;
};

type ViewerContentResult = {
  html: string;
  format?: string;
};

export async function renderViewer(env: Env, object: ObjectRow, options: ViewerOptions) {
  if (object.object_kind === "folder") {
    throw new HttpError(400, "folder_not_viewable");
  }
  const version = await requireCurrentVersion(env, object);
  let bytes = new Uint8Array();
  if (object.content_kind !== "binary" && !object.mime_type.startsWith("audio/")) {
    const r2Object = await env.KNOWLEDGE_OBJECTS.get(version.r2_key);
    if (!r2Object) throw new HttpError(404, "r2_object_not_found");
    bytes = new Uint8Array(await r2Object.arrayBuffer());
  } else if (!await env.KNOWLEDGE_OBJECTS.head(version.r2_key)) {
    throw new HttpError(404, "r2_object_not_found");
  }
  const body = await viewerHtml(env, object, version, bytes, options);
  const scriptSrc = object.content_kind === "html" ? "script-src 'unsafe-inline'" : "script-src 'none'";
  return html(body, {
    headers: {
      "Cache-Control": options.cacheControl,
      "Content-Security-Policy": [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "media-src 'self' data: blob: https:",
        "frame-src 'self' blob: data:",
        scriptSrc,
        "connect-src 'self'",
        "worker-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "object-src 'none'"
      ].join("; ")
    }
  });
}

async function viewerHtml(env: Env, object: ObjectRow, version: VersionRow, bytes: Uint8Array, options: ViewerOptions) {
  const title = escapeHtml(object.file_name);
  const subtitle = escapeHtml(viewerFolderPath(object));
  const contentResult = object.mime_type.startsWith("audio/")
    ? { html: `<article class="doc"><h1>${escapeHtml(object.file_name)}</h1><audio controls preload="metadata" src="${escapeAttribute(options.rawUrl || `../api/files/${encodeURIComponent(object.id)}/raw`)}"></audio></article>` }
    : await viewerContent(env, object, version, bytes);
  const content = contentResult.html;
  const isDeck = contentResult.format === "deck";
  const bodyClass = [options.embedded ? "embedded" : "", isDeck ? "deckViewer" : ""].filter(Boolean).join(" ");
  const contentClass = `body ${escapeAttribute(object.content_kind || "binary")}${isDeck ? " deckContent" : ""}`;
  const header = options.embedded ? "" : `<header><div><strong>${title}</strong><span>${subtitle}</span></div><span>Knowledge Worker Viewer</span></header>`;
  const deckChrome = isDeck ? `<div class="deckHint" id="deckHint">← → 翻页 · F 全屏 · Cmd + [ ] 投屏校正 · Cmd + 0 恢复</div>
  <div class="deckControls" id="deckControls" aria-label="Deck controls">
    <button type="button" id="viewerPrev" aria-label="上一页">‹</button>
    <span class="deckCounter" id="viewerCounter">01 / --</span>
    <button type="button" id="viewerNext" aria-label="下一页">›</button>
  </div>` : "";
  const deckScript = isDeck ? `<script>
    (() => {
      const navKeys = {
        ArrowRight: "next",
        ArrowDown: "next",
        PageDown: "next",
        " ": "next",
        Spacebar: "next",
        Enter: "next",
        ArrowLeft: "prev",
        ArrowUp: "prev",
        PageUp: "prev",
        Backspace: "prev",
        Home: "home",
        End: "end"
      };
      const sendDeckMessage = (message) => {
        const frame = document.querySelector("iframe.htmlFrame");
        try {
          if (frame && frame.contentWindow) {
            frame.contentWindow.postMessage(message, "*");
          }
        } catch (_) {}
      };
      const sendNav = (action) => sendDeckMessage({ type: "workspace-deck-nav", action });
      const sendDisplay = (action) => sendDeckMessage({ type: "workspace-deck-display", action });
      const pad = (n) => n < 10 ? "0" + n : "" + n;
      const state = { current: 1, total: null };
      const counter = document.getElementById("viewerCounter");
      const prevButton = document.getElementById("viewerPrev");
      const nextButton = document.getElementById("viewerNext");
      const updateChrome = () => {
        if (counter) counter.textContent = pad(state.current) + " / " + (Number.isFinite(state.total) ? pad(state.total) : "--");
        if (prevButton) prevButton.disabled = state.current <= 1;
        if (nextButton) nextButton.disabled = Number.isFinite(state.total) && state.current >= state.total;
      };
      const toggleFullscreen = () => {
        const active = document.fullscreenElement || document.webkitFullscreenElement;
        if (active) {
          const exit = document.exitFullscreen || document.webkitExitFullscreen;
          if (!exit) return;
          try {
            const result = exit.call(document);
            if (result && typeof result.catch === "function") result.catch(() => {});
          } catch (_) {}
          return;
        }

        const target = document.documentElement;
        const request = target.requestFullscreen || target.webkitRequestFullscreen;
        if (!request) return;
        try {
          const result = request.call(target);
          if (result && typeof result.catch === "function") result.catch(() => {});
        } catch (_) {}
      };
      if (prevButton) prevButton.addEventListener("click", () => sendNav("prev"));
      if (nextButton) nextButton.addEventListener("click", () => sendNav("next"));
      document.addEventListener("keydown", (event) => {
        const target = event.target;
        const tag = target && target.tagName ? target.tagName.toLowerCase() : "";
        if (tag === "input" || tag === "textarea" || tag === "select" || (target && target.isContentEditable)) return;
        if (event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey && (event.key === "[" || event.code === "BracketLeft")) {
          event.preventDefault();
          sendDisplay("correction-narrow");
          return;
        }
        if (event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey && (event.key === "]" || event.code === "BracketRight")) {
          event.preventDefault();
          sendDisplay("correction-wide");
          return;
        }
        if (event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey && (event.key === "0" || event.code === "Digit0")) {
          event.preventDefault();
          sendDisplay("correction-reset");
          return;
        }
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.key.toLowerCase() === "f") {
          event.preventDefault();
          toggleFullscreen();
          return;
        }
        const action = navKeys[event.key];
        if (!action) return;
        event.preventDefault();
        sendNav(action);
      }, true);
      window.addEventListener("message", (event) => {
        if (event.data && event.data.type === "workspace-deck-fullscreen") toggleFullscreen();
        if (event.data && event.data.type === "workspace-deck-chrome") {
          document.body.classList.toggle("deckChromeHidden", !!event.data.hidden);
        }
        if (event.data && event.data.type === "workspace-deck-state") {
          const current = Number(event.data.current);
          const total = Number(event.data.total);
          if (Number.isFinite(current) && current >= 1) state.current = current;
          if (Number.isFinite(total) && total >= 1) state.total = total;
          updateChrome();
        }
      });
      updateChrome();
      const hint = document.getElementById("deckHint");
      if (hint) setTimeout(() => hint.classList.add("hide"), 4000);
    })();
  </script>` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} · My Knowledge</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111318; background: #f8f9fc; }
    body { margin: 0; min-height: 100vh; background: #f8f9fc; }
    main { min-height: 100vh; display: grid; grid-template-rows: auto minmax(0, 1fr); }
    body.embedded main { grid-template-rows: minmax(0, 1fr); }
    header { display: flex; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid #e1e5ec; background: #fff; padding: 12px 16px; }
    header strong { display: block; overflow: hidden; max-width: 64vw; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
    header span { display: block; overflow: hidden; max-width: 64vw; color: #626a78; font-size: 12px; font-weight: 760; text-overflow: ellipsis; white-space: nowrap; }
    .body { min-height: 0; overflow: auto; padding: 28px; }
    .body.image { display: grid; place-items: center; padding: 24px; }
    .body.html, .body.pdf { overflow: hidden; padding: 0; }
    .doc { box-sizing: border-box; width: min(960px, 100%); margin: 0 auto; border: 1px solid #e1e5ec; border-radius: 8px; background: #fff; padding: clamp(24px, 4vw, 52px); box-shadow: 0 8px 24px rgba(17, 19, 24, .06); overflow-wrap: break-word; }
    .doc > * { margin-top: 0; margin-bottom: 0; }
    .doc > * + * { margin-top: 16px; }
    .doc h1, .doc h2, .doc h3, .doc h4, .doc h5, .doc h6 { color: #111318; font-weight: 850; line-height: 1.28; }
    .doc h1 { font-size: 2em; line-height: 1.18; }
    .doc h2 { font-size: 1.55em; }
    .doc h3 { font-size: 1.25em; }
    .doc h4, .doc h5, .doc h6 { font-size: 1em; }
    .doc p, .doc li { color: #4f5968; font-size: 16px; line-height: 1.75; }
    .doc ul, .doc ol { padding-left: 1.5em; }
    .doc li + li { margin-top: 6px; }
    .doc li > ul, .doc li > ol { margin-top: 6px; }
    .doc blockquote { margin-right: 0; margin-left: 0; border-left: 3px solid #2563eb; background: #f8f9fc; color: #4f5968; padding: 10px 14px; }
    .doc blockquote > * { margin-top: 0; margin-bottom: 0; }
    .doc blockquote > * + * { margin-top: 8px; }
    .doc a { color: #1d4ed8; text-decoration: underline; text-underline-offset: 2px; }
    .doc strong { color: #111318; font-weight: 800; }
    .doc code { border: 1px solid #e1e5ec; border-radius: 4px; background: #f8f9fc; color: #111318; padding: 1px 5px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .9em; }
    .doc pre { overflow: auto; border: 1px solid #e1e5ec; border-radius: 8px; background: #f8f9fc; padding: 16px; line-height: 1.6; }
    .doc pre code { border: 0; background: transparent; padding: 0; white-space: pre; }
    .doc img { display: block; max-width: 100%; height: auto; margin-right: auto; margin-left: auto; }
    .doc hr { border: 0; border-top: 1px solid #e1e5ec; }
    .markdownTable { max-width: 100%; overflow-x: auto; }
    .markdownTable table { width: 100%; min-width: 560px; border-collapse: collapse; font-size: .94em; }
    .markdownTable th, .markdownTable td { border: 1px solid #d7dce5; padding: 9px 12px; color: #4f5968; line-height: 1.55; text-align: left; vertical-align: top; }
    .markdownTable th { background: #f3f5f8; color: #111318; font-weight: 800; }
    .markdownTable tbody tr:nth-child(even) { background: #fafbfc; }
    .csvDoc { width: max-content; min-width: 100%; max-width: none; padding: 0; }
    .csvTable { overflow: auto; max-width: 100vw; }
    .csvTable table { min-width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; }
    .csvTable th, .csvTable td { max-width: 420px; border-right: 1px solid #d7dce5; border-bottom: 1px solid #d7dce5; padding: 8px 11px; color: #4f5968; line-height: 1.5; text-align: left; vertical-align: top; white-space: pre-wrap; overflow-wrap: anywhere; }
    .csvTable th { position: sticky; z-index: 1; top: 0; background: #f3f5f8; color: #111318; font-weight: 800; white-space: nowrap; }
    .csvTable tbody tr:nth-child(even) { background: #fafbfc; }
    .csvNotice { margin: 0; border-top: 1px solid #d7dce5; padding: 10px 12px; color: #626a78; font-size: 12px; }
    .markdownTaskList { padding-left: .4em !important; list-style: none; }
    .markdownTaskListItem { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-start; }
    .markdownTaskListItem > p:first-child { display: contents; }
    .markdownTaskListItem > ul, .markdownTaskListItem > ol { flex-basis: 100%; }
    .markdownTaskListItemCheckbox { flex: none; margin: .42em 0 0; accent-color: #2563eb; }
    img.viewerImage { display: block; max-width: 100%; max-height: calc(100vh - 148px); object-fit: contain; border: 1px solid #e1e5ec; border-radius: 8px; background: #fff; box-shadow: 0 8px 24px rgba(17, 19, 24, .06); }
    body.embedded img.viewerImage { max-height: calc(100vh - 48px); }
    iframe.htmlFrame, iframe.pdfFrame { width: 100%; height: calc(100vh - 78px); border: 0; background: #fff; }
    body.embedded iframe.htmlFrame, body.embedded iframe.pdfFrame { height: 100vh; }
    .deckHint { position: fixed; top: 14px; left: 50%; z-index: 20; transform: translateX(-50%); border-radius: 999px; background: rgba(17, 19, 24, .92); color: #fff; padding: 8px 16px; font-size: 11px; font-weight: 760; letter-spacing: 1.6px; line-height: 1; pointer-events: none; opacity: 1; transition: opacity .24s ease, transform .24s ease; }
    .deckHint.hide { opacity: 0; transform: translate(-50%, -8px); }
    .deckControls { position: fixed; bottom: 14px; left: 50%; z-index: 20; display: flex; align-items: center; gap: 12px; transform: translateX(-50%); border: 1px solid rgba(225, 229, 236, .92); background: rgba(255, 255, 255, .94); padding: 8px 12px; box-shadow: 0 14px 36px rgba(17, 19, 24, .10); }
    .deckControls button { display: grid; place-items: center; width: 40px; height: 40px; border: 1px solid #e1e5ec; border-radius: 999px; background: #fff; color: #111318; font-size: 26px; line-height: 1; cursor: pointer; }
    .deckControls button:disabled { opacity: .36; cursor: default; }
    .deckCounter { min-width: 66px; color: #626a78; font-size: 12px; font-weight: 800; letter-spacing: 1.2px; text-align: center; }
    body:not(.deckViewer) .deckHint, body:not(.deckViewer) .deckControls { display: none; }
    body.deckChromeHidden .deckHint, body.deckChromeHidden .deckControls { display: none; }
    @media (max-width: 640px) {
      .body { padding: 12px; }
      .doc { border-radius: 6px; padding: 22px 18px; }
      .doc h1 { font-size: 1.65em; }
      .doc h2 { font-size: 1.35em; }
      .doc p, .doc li { font-size: 15px; }
    }
  </style>
</head>
<body class="${bodyClass}">
  <main>
    ${header}
    <section class="${contentClass}">${content}</section>
  </main>
  ${deckChrome}
  ${deckScript}
</body>
</html>`;
}

async function viewerContent(env: Env, object: ObjectRow, version: VersionRow, bytes: Uint8Array): Promise<ViewerContentResult> {
  if (object.content_kind === "html") {
    const source = new TextDecoder().decode(bytes);
    const format = uploadedHtmlFormat(source);
    const interactive = effectiveKnowledgePolicy(env).html.interactiveModeEnabled
      && (format === "deck" || format === "interactive");
    const sanitized = sanitizeUploadedHtml(source, interactive);
    const framed = format === "deck" ? addDeckViewerOverrides(sanitized) : sanitized;
    return {
      html: `<iframe class="htmlFrame" title="${escapeAttribute(object.file_name)}" allow="fullscreen" allowfullscreen sandbox="${interactive ? "allow-scripts allow-popups" : ""}" srcdoc="${escapeAttribute(framed)}"></iframe>`,
      format
    };
  }
  if (object.content_kind === "csv" || object.mime_type.toLowerCase().split(";", 1)[0] === "text/csv" || object.file_name.toLowerCase().endsWith(".csv")) {
    return { html: renderKnowledgeCsv(new TextDecoder().decode(bytes)) };
  }
  if (object.content_kind === "markdown" || object.content_kind === "text") {
    const source = new TextDecoder().decode(bytes);
    return { html: `<article class="doc markdownBody">${renderKnowledgeMarkdown(source)}</article>` };
  }
  if (object.content_kind === "image") {
    const src = bytesToDataUrl(bytes, version.mime_type || object.mime_type || contentTypeFromName(object.file_name));
    return { html: `<img class="viewerImage" alt="${escapeAttribute(object.file_name)}" src="${escapeAttribute(src)}" />` };
  }
  if (object.content_kind === "pdf") {
    const src = bytesToDataUrl(bytes, version.mime_type || object.mime_type || "application/pdf");
    return { html: `<iframe class="pdfFrame" src="${escapeAttribute(src)}"></iframe>` };
  }
  return { html: `<article class="doc"><h1>${escapeHtml(object.file_name)}</h1><p>This file type is available for download.</p></article>` };
}

function renderKnowledgeCsv(source: string) {
  const preview = parseCsvPreview(source);
  const [header = [], ...rows] = preview.rows;
  if (!header.length) return '<article class="doc"><p>CSV file is empty.</p></article>';
  const head = header.map((cell) => `<th scope="col">${escapeHtml(cell)}</th>`).join("");
  const body = rows.map((row) => `<tr>${header.map((_, index) => `<td>${escapeHtml(row[index] ?? "")}</td>`).join("")}</tr>`).join("");
  const notice = preview.truncatedColumns || preview.truncatedRows
    ? '<p class="csvNotice">Preview limited to the first 2,000 rows and 100 columns. Download the file to view all content.</p>'
    : "";
  return `<article class="doc csvDoc"><div class="csvTable"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${notice}</article>`;
}

function uploadedHtmlFormat(source: string) {
  const metas = source.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of metas) {
    const name = metaAttribute(tag, "name")?.trim().toLowerCase();
    if (name !== "workspace:format" && name !== "huozi:format") continue;
    return metaAttribute(tag, "content")?.trim().toLowerCase();
  }
  return undefined;
}

function metaAttribute(tag: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp("\\b" + escaped + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s\"'>]+))", "i"));
  if (!match) return undefined;
  return match[2] ?? match[3] ?? match[4] ?? "";
}

function addDeckViewerOverrides(source: string) {
  const style = `<style data-workspace-viewer>
    .hint, .controls { display: none !important; }
  </style>`;
  if (source.includes("data-workspace-viewer")) return source;
  if (/<\/head>/i.test(source)) {
    return source.replace(/<\/head>/i, `${style}</head>`);
  }
  return `${style}${source}`;
}

function sanitizeUploadedHtml(source: string, allowInlineScripts: boolean) {
  const withoutDangerousBlocks = source
    .replace(/<script\b[^>]*\bsrc\s*=\s*(['"]).*?\1[^>]*>\s*<\/script>/gis, "")
    .replace(allowInlineScripts ? /$^/ : /<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object\b[\s\S]*?<\/object>/gi, "")
    .replace(/<embed\b[\s\S]*?>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gi, "");
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src data: blob: https:",
    "media-src data: blob: https:",
    allowInlineScripts ? "script-src 'unsafe-inline'" : "script-src 'none'",
    "connect-src 'none'",
    "font-src data:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join("; ");
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">`;
  if (/<head\b[^>]*>/i.test(withoutDangerousBlocks)) {
    return withoutDangerousBlocks.replace(/<head\b([^>]*)>/i, `<head$1>${meta}`);
  }
  return `${meta}${withoutDangerousBlocks}`;
}

export function renderKnowledgeMarkdown(source: string) {
  return renderMarkdown(source);
}

function viewerFolderPath(object: ObjectRow) {
  return object.parent_path ? `My Library / ${object.parent_path}` : "My Library";
}

function safeDownloadName(value: string) {
  return value.replace(/[^\w.\-() ]+/g, "_").slice(0, 180) || "download";
}

function bytesToDataUrl(bytes: Uint8Array, mimeType: string) {
  const safeType = safeMimeType(mimeType);
  return `data:${safeType};base64,${bytesToBase64(bytes)}`;
}

function safeMimeType(value: string) {
  const candidate = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(candidate) ? candidate : "application/octet-stream";
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
