import type { Mate } from "../../shared/mate";

export async function loadMateBuilderSelection(
  summary: Mate,
  refresh: (mateId: string) => Promise<Mate | undefined>
) {
  const mate = await refresh(summary.id);
  return mate?.draftManifest && Array.isArray(mate.draftDocuments)
    ? mate
    : undefined;
}
