const MODEL_BRANDS: Record<string, string> = {
  deepseek: "DeepSeek", minimax: "MiniMax", mimo: "MiMo", gpt: "GPT", glm: "GLM"
};

/** Prefer catalog names; make legacy profiles readable without changing routing IDs. */
export function modelDisplayName(id: string, name?: string): string {
  const catalogName = name?.trim();
  if (catalogName && catalogName !== id) {
    return id === "cf-openai-gpt-6-luna" || id === "cf-anthropic-claude-haiku-5.5"
      ? catalogName.replace(/\s*\(Cloudflare\)$/i, "")
      : catalogName;
  }
  return id
    .replace(/^(?:cf-)?(?:openai|tencent|anthropic|bedrock|google)-/i, "")
    .replace(/-/g, " ")
    .replace(/\b(gpt|glm) (\d+(?:\.\d+)*)/gi, (_, brand: string, version: string) => `${brand.toUpperCase()}-${version}`)
    .replace(/\b[a-z][a-z\d.]*/gi, (word) => MODEL_BRANDS[word.toLowerCase()] ?? word.charAt(0).toUpperCase() + word.slice(1));
}
