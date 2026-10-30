import { CLOUDFLARE_HAIKU_MODEL } from "./cloudflareHaiku.ts";
import type { RuntimeDefinition } from "./types.ts";

/** Only enable native PDF on the public route verified with text and scanned PDFs. */
export function nativePdfEnabled(definition: RuntimeDefinition, modelId: string) {
  return modelId === CLOUDFLARE_HAIKU_MODEL
    && definition.release.manifest.modelPolicy?.multimodal?.documentInput === true
    && definition.release.manifest.resources.builtInToolBindings.some((binding) => binding.toolId === "document_read");
}
