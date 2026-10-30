/**
 * Markdown block parser for assistant replies.
 *
 * Pure and platform-neutral, so it can be unit tested and benchmarked outside the
 * mini-program runtime. The view layer (`components/MarkdownMessage.tsx`) owns rendering.
 */

export type MarkdownBlock =
  | { type: "code"; language: string; value: string }
  | { type: "heading"; level: number; value: string }
  | { type: "hr" }
  | { type: "list"; items: Array<{ indent: number; marker: string; ordered: boolean; value: string }> }
  | { type: "paragraph"; value: string }
  | { type: "quote"; value: string }
  | { type: "table"; header: string[]; rows: string[][] };

export function parseBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    const fence = line.match(/^\s*```([^`]*)$/);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) { code.push(lines[index]); index += 1; }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", language: fence[1].trim(), value: code.join("\n") });
      continue;
    }

    if (isTableHeader(lines, index)) {
      const header = tableCells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(tableCells(lines[index])); index += 1;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (heading) { blocks.push({ type: "heading", level: heading[1].length, value: heading[2].trim() }); index += 1; continue; }
    if (/^\s{0,3}((\*|-|_)\s*){3,}$/.test(line)) { blocks.push({ type: "hr" }); index += 1; continue; }

    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, "")); index += 1;
      }
      blocks.push({ type: "quote", value: quote.join("\n") });
      continue;
    }

    if (listMatch(line)) {
      const items: Extract<MarkdownBlock, { type: "list" }>["items"] = [];
      while (index < lines.length) {
        const item = listMatch(lines[index]);
        if (!item) break;
        items.push({ indent: item[1].length, marker: item[2], ordered: /^\d/.test(item[2]), value: item[3] });
        index += 1;
      }
      blocks.push({ type: "list", items });
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines, index)) {
      paragraph.push(lines[index].trim()); index += 1;
    }
    blocks.push({ type: "paragraph", value: paragraph.join("\n") });
  }
  return blocks;
}

function listMatch(line: string) {
  return line.match(/^(\s*)([-+*]|\d+[.)])\s+(.+)$/);
}

function startsBlock(lines: string[], index: number) {
  const line = lines[index];
  return /^\s*```/.test(line)
    || /^\s*(#{1,6})\s+/.test(line)
    || /^\s*>/.test(line)
    || Boolean(listMatch(line))
    || /^\s{0,3}((\*|-|_)\s*){3,}$/.test(line)
    || isTableHeader(lines, index);
}

function isTableHeader(lines: string[], index: number) {
  return Boolean(lines[index]?.includes("|") && lines[index + 1]
    && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1]));
}

function tableCells(line: string) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}
