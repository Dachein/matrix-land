import { HttpError } from "./http.ts";
import { KnowledgeTextPatchError, parseKnowledgeTextPatch } from "../../../src/shared/knowledgeTextPatch.ts";

export function applyUnifiedTextPatch(before: string, rawPatch: string) {
  let hunks: ReturnType<typeof parseKnowledgeTextPatch>;
  try { hunks = parseKnowledgeTextPatch(rawPatch); }
  catch (error) {
    if (error instanceof KnowledgeTextPatchError) throw new HttpError(400, error.code);
    throw error;
  }
  const sourceLines = before.replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  let sourceCursor = 0;
  for (const hunk of hunks) {
    if (hunk.sourceStart > sourceLines.length) throw new HttpError(409, "knowledge_edit_patch_context_mismatch");
    output.push(...sourceLines.slice(sourceCursor, hunk.sourceStart));
    sourceCursor = hunk.sourceStart;
    for (const line of hunk.lines) {
      const prefix = line[0];
      const value = line.slice(1);
      if (prefix !== "+") {
        if (sourceLines[sourceCursor] !== value) throw new HttpError(409, "knowledge_edit_patch_context_mismatch");
        sourceCursor++;
      }
      if (prefix !== "-") output.push(value);
    }
  }
  output.push(...sourceLines.slice(sourceCursor));
  return output.join("\n");
}
