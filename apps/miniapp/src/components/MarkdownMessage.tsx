import { ScrollView, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import type { ReactNode } from "react";
import { parseBlocks, type MarkdownBlock } from "../services/markdown";
import { mateFileReferenceFromUrl } from "../../../../src/shared/mateFileReference.js";
import { MateFileLink } from "./MateFileLink";
import "./MarkdownMessage.scss";

export function MarkdownMessage({ content, onOpenFile }: { content: string; onOpenFile?: (url: string, fileName: string) => void }) {
  return <View className="markdown-message">
    {parseBlocks(content).map((block, index) => renderBlock(block, index, onOpenFile))}
  </View>;
}

function renderBlock(block: MarkdownBlock, index: number, onOpenFile?: (url: string, fileName: string) => void) {
  if (block.type === "heading") {
    return <View key={index} className={`md-heading md-h${Math.min(block.level, 4)}`}>
      {inlineWithBreaks(block.value, `heading-${index}`, onOpenFile)}
    </View>;
  }
  if (block.type === "paragraph") {
    return <View key={index} className="md-paragraph">{inlineWithBreaks(block.value, `paragraph-${index}`, onOpenFile)}</View>;
  }
  if (block.type === "quote") {
    return <View key={index} className="md-quote">{inlineWithBreaks(block.value, `quote-${index}`, onOpenFile)}</View>;
  }
  if (block.type === "hr") return <View key={index} className="md-rule" />;
  if (block.type === "list") {
    return <View key={index} className="md-list">
      {block.items.map((item, itemIndex) => <View
        key={itemIndex}
        className="md-list-item"
        style={{ paddingLeft: `${Math.min(4, Math.floor(item.indent / 2)) * 24}px` }}
      >
        <Text className="md-list-marker">{item.ordered ? item.marker : "•"}</Text>
        <View className="md-list-content">{inlineWithBreaks(item.value, `list-${index}-${itemIndex}`, onOpenFile)}</View>
      </View>)}
    </View>;
  }
  if (block.type === "code") {
    return <View key={index} className="md-code-wrap">
      {block.language && <Text className="md-code-language">{block.language}</Text>}
      <ScrollView className="md-code-scroll" scrollX enhanced>
        <Text className="md-code-block" userSelect>{block.value}</Text>
      </ScrollView>
    </View>;
  }
  return <ScrollView key={index} className="md-table-scroll" scrollX enhanced>
    <View className="md-table">
      <View className="md-table-row md-table-header">
        {block.header.map((cell, cellIndex) => <View key={cellIndex} className="md-table-cell">
          {inlineWithBreaks(cell, `table-${index}-head-${cellIndex}`, onOpenFile)}
        </View>)}
      </View>
      {block.rows.map((row, rowIndex) => <View key={rowIndex} className="md-table-row">
        {block.header.map((_cell, cellIndex) => <View key={cellIndex} className="md-table-cell">
          {inlineWithBreaks(row[cellIndex] || "", `table-${index}-${rowIndex}-${cellIndex}`, onOpenFile)}
        </View>)}
      </View>)}
    </View>
  </ScrollView>;
}

function inlineWithBreaks(value: string, keyPrefix: string, onOpenFile?: (url: string, fileName: string) => void) {
  const lines = value.split("\n");
  const nodes: ReactNode[] = [];
  lines.forEach((line, index) => {
    nodes.push(...parseInline(line, `${keyPrefix}-${index}`, onOpenFile));
    if (index < lines.length - 1) nodes.push(<Text key={`${keyPrefix}-break-${index}`}>{"\n"}</Text>);
  });
  return nodes;
}

function parseInline(value: string, keyPrefix: string, onOpenFile?: (url: string, fileName: string) => void): ReactNode[] {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\[[^\]\n]+\]\((?:https?:\/\/|\/api\/workspace-files\/)[^)\s]+\)|\*[^*\n]+\*|_[^_\n]+_)/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  let tokenIndex = 0;
  while ((match = pattern.exec(value))) {
    if (match.index > cursor) nodes.push(<Text key={`${keyPrefix}-text-${tokenIndex}`}>{value.slice(cursor, match.index)}</Text>);
    const token = match[0];
    const key = `${keyPrefix}-token-${tokenIndex}`;
    if (token.startsWith("`")) {
      nodes.push(<Text key={key} className="md-inline-code" userSelect>{token.slice(1, -1)}</Text>);
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(<Text key={key} className="md-strong">{token.slice(2, -2)}</Text>);
    } else if (token.startsWith("~~")) {
      nodes.push(<Text key={key} className="md-strike">{token.slice(2, -2)}</Text>);
    } else if (token.startsWith("[")) {
      const link = token.match(/^\[([^\]]+)\]\(((?:https?:\/\/|\/api\/workspace-files\/)[^)\s]+)\)$/);
      const label = link?.[1] || token;
      const url = link?.[2] || "";
      const file = mateFileReferenceFromUrl(url, label);
      if (file && onOpenFile) { nodes.push(<MateFileLink key={key} file={file} onOpen={selected => onOpenFile(selected.url, selected.fileName)} />); }
      else nodes.push(<Text key={key} className="md-link" userSelect onClick={() => file && onOpenFile ? onOpenFile(file.url, file.fileName) : copyLink(url)}>{label}</Text>);
    } else {
      nodes.push(<Text key={key} className="md-emphasis">{token.slice(1, -1)}</Text>);
    }
    cursor = match.index + token.length;
    tokenIndex += 1;
  }
  if (cursor < value.length) nodes.push(<Text key={`${keyPrefix}-tail`}>{value.slice(cursor)}</Text>);
  return nodes;
}

function copyLink(url: string) {
  if (url) void Taro.setClipboardData({ data: url });
}
