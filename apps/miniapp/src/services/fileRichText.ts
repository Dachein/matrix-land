import { parseDocument } from "htmlparser2";
import { isTag, isText, type Node } from "domhandler";
import MarkdownIt from "markdown-it";

export type PreviewNode = { type: "text"; text: string } | {
  name: string; attrs: Record<string, string>; children: PreviewNode[];
};
const markdown = new MarkdownIt({ html: false, breaks: true });
const allowed = new Set("a abbr b blockquote br code col colgroup dd del div dl dt em h1 h2 h3 h4 h5 h6 hr i img ins li ol p pre span strong sub sup table tbody td tfoot th thead tr ul".split(" "));
const hidden = new Set("head script style iframe object embed form input button textarea select option svg math video audio canvas template link meta".split(" "));
const styles: Record<string, string> = {
  h1: "font-size:26px;font-weight:bold;margin:20px 0 14px;line-height:1.3;",
  h2: "font-size:22px;font-weight:bold;margin:18px 0 12px;line-height:1.4;",
  h3: "font-size:19px;font-weight:bold;margin:16px 0 10px;",
  p: "margin:12px 0;", ul: "padding-left:24px;", ol: "padding-left:24px;", li: "margin:6px 0;",
  blockquote: "margin:14px 0;padding:6px 14px;border-left:3px solid #a9ba8d;color:#66665d;",
  pre: "white-space:pre-wrap;word-break:break-all;padding:12px;background-color:#eeede7;border-radius:4px;",
  code: "font-family:monospace;background-color:#eeede7;", a: "color:#46652b;text-decoration:underline;",
  table: "border-collapse:collapse;width:100%;", td: "border:1px solid #d9d7ce;padding:8px;word-break:break-word;",
  th: "border:1px solid #d9d7ce;padding:8px;background-color:#eeede7;font-weight:bold;",
  img: "max-width:100%;height:auto;", hr: "border:0;border-top:1px solid #d9d7ce;margin:18px 0;"
};
const styleProperties = new Set("color background-color font-size font-weight font-style font-family line-height text-align text-decoration white-space word-break overflow-wrap border border-top border-bottom border-left border-right border-collapse border-radius padding padding-top padding-right padding-bottom padding-left margin margin-top margin-right margin-bottom margin-left width max-width height vertical-align".split(" "));

function safeStyle(style: string) {
  return style.split(";").flatMap((declaration) => {
    const separator = declaration.indexOf(":");
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    // Keep visual formatting; exclude URLs, expressions and CSS escapes entirely.
    if (separator < 0 || !styleProperties.has(property) || !/^[\w\s#.,%()+/-]+$/.test(value) || /url|expression|var\s*\(/i.test(value)) return [];
    return [`${property}:${value}`];
  }).join(";");
}

function imageUrl(value: string) {
  // Use the same URL shape as native chat links; WeChat does not require a DOM URL global.
  return /^https:\/\/[a-z0-9.-]+(?::\d+)?(?:[/?#][^\s"<>\\]*)?$/i.test(value) ? value : "";
}

/** Render document content as native rich-text nodes, never as an executable web page. */
export function fileRichText(content: string, kind: "html" | "markdown") {
  const document = parseDocument(kind === "markdown" ? markdown.render(content) : content);
  let count = 0;
  let truncated = false;
  function visit(nodes: Node[], depth = 0): PreviewNode[] {
    const result: PreviewNode[] = [];
    for (const node of nodes) {
      if (++count > 4000 || depth > 40) { truncated = true; break; }
      if (isText(node)) { result.push({ type: "text", text: node.data }); continue; }
      if (!isTag(node) || hidden.has(node.name)) continue;
      const children = visit(node.children, depth + 1);
      if (!allowed.has(node.name)) { result.push(...children); continue; }
      const attrs: Record<string, string> = { style: `${styles[node.name] || ""}${safeStyle(node.attribs.style || "")}` };
      if (node.name === "img") {
        const src = imageUrl(node.attribs.src || "");
        if (!src) { result.push({ type: "text", text: node.attribs.alt ? `[${node.attribs.alt}]` : "" }); continue; }
        attrs.src = src; attrs.alt = node.attribs.alt || "";
        // A document's fixed image dimensions must not overflow a phone screen.
        attrs.style += ";max-width:100%;height:auto;";
      }
      for (const attribute of ["colspan", "rowspan", "span", "start"]) {
        if (/^\d{1,3}$/.test(node.attribs[attribute] || "")) attrs[attribute] = node.attribs[attribute];
      }
      result.push({ name: node.name, attrs, children });
    }
    return result;
  }
  const nodes = visit(document.children);
  return { nodes, truncated };
}
