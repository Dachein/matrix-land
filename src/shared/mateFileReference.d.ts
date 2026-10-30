export type MateFileReference = {
  fileName: string;
  objectId: string;
  source: "knowledge" | "workspace";
  url: string;
};

export function mateFileReference(objectId: unknown, fileName: unknown): MateFileReference | undefined;
export function mateFileReferenceFromUrl(url: unknown, fileName: unknown): MateFileReference | undefined;
export function mateFileReferencesFromCitations(value: unknown): MateFileReference[];
export function mateFileReferencesFromTool(toolName: string, value: unknown): MateFileReference[];
