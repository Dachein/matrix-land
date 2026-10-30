import MarkdownIt from "markdown-it";
import { useMemo } from "react";

const markdown = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
  typographer: false
});

// Agent output must never create executable HTML or load arbitrary images.
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content || "");
markdown.renderer.rules.link_open = (tokens, index, options, _env, self) => {
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noreferrer noopener");
  return self.renderToken(tokens, index, options);
};

const fileMarker = /<<FILE:\s*([^>\r\n]+)>>/g;

/** Shared safe Markdown renderer for Standalone, Preview, and Embedded chat. */
export function MateMarkdownMessage({ content, stripFileMarkers = true }: { content: string; stripFileMarkers?: boolean }) {
  const html = useMemo(() => markdown.render(stripFileMarkers ? content.replace(fileMarker, "") : content), [content, stripFileMarkers]);
  return <div className="tm-agent-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
