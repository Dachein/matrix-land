export function youtubeEmbedUrl(value: string) {
  try {
    const url = new URL(value);
    const id = readYoutubeId(url);
    return id ? `https://www.youtube-nocookie.com/embed/${id}` : undefined;
  } catch {
    return undefined;
  }
}

function readYoutubeId(url: URL) {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");

  if (host === "youtu.be") {
    return cleanYoutubeId(url.pathname.split("/").filter(Boolean)[0]);
  }

  if (host !== "youtube.com" && host !== "m.youtube.com") {
    return undefined;
  }

  const queryId = cleanYoutubeId(url.searchParams.get("v") ?? "");

  if (queryId) {
    return queryId;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const markerIndex = parts.findIndex((part) => ["embed", "shorts", "live"].includes(part));
  return markerIndex >= 0 ? cleanYoutubeId(parts[markerIndex + 1]) : undefined;
}

function cleanYoutubeId(value: string | undefined) {
  const id = value?.trim() ?? "";
  return /^[a-zA-Z0-9_-]{6,32}$/.test(id) ? id : undefined;
}
