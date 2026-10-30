/** One-file unified diff grammar shared by proposal validation and execution. */
export class KnowledgeTextPatchError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}

export function parseKnowledgeTextPatch(rawPatch: unknown) {
  const invalid = () => { throw new KnowledgeTextPatchError("knowledge_edit_patch_invalid"); };
  if (typeof rawPatch !== "string" || !rawPatch.trim()) return invalid();
  const lines = rawPatch.replace(/\r\n?/g, "\n").split("\n");
  const hunks: Array<{ sourceStart: number; lines: string[] }> = [];
  let cursor = 0;
  let previousEnd = 0;
  while (cursor < lines.length) {
    const header = lines[cursor++];
    const match = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/);
    if (!match) {
      if (header === "" || (!hunks.length && /^(--- |\+\+\+ |diff |index )/.test(header))) continue;
      return invalid();
    }
    const [oldStart, oldCount, newStart, newCount] = [Number(match[1]), Number(match[2] ?? 1), Number(match[3]), Number(match[4] ?? 1)];
    if (![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger)
      || (oldCount > 0 && oldStart === 0) || (newCount > 0 && newStart === 0)) return invalid();
    // Empty old ranges insert AFTER oldStart; nonempty ranges are one-based.
    const sourceStart = oldCount === 0 ? oldStart : oldStart - 1;
    if (sourceStart < previousEnd) return invalid();
    const body: string[] = [];
    let removed = 0;
    let added = 0;
    while (cursor < lines.length && !lines[cursor].startsWith("@@ ")) {
      const line = lines[cursor++];
      if (line === "\\ No newline at end of file" || (line === "" && cursor === lines.length)) continue;
      if (!/^[ +\-]/.test(line)) return invalid();
      body.push(line);
      if (line[0] !== "+") removed++;
      if (line[0] !== "-") added++;
    }
    if (removed !== oldCount || added !== newCount) throw new KnowledgeTextPatchError("knowledge_edit_patch_count_mismatch");
    previousEnd = sourceStart + oldCount;
    hunks.push({ sourceStart, lines: body });
  }
  if (!hunks.length) return invalid();
  return hunks;
}
