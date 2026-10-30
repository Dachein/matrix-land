export function formatCompactCount(value: number) {
  if (value >= 1000000) {
    return `${trimCompactNumber(value / 1000000)}M`;
  }

  if (value >= 1000) {
    return `${trimCompactNumber(value / 1000)}K`;
  }

  return value.toString();
}

function trimCompactNumber(value: number) {
  return value >= 10 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, "");
}

export function formatBytes(value?: number) {
  const bytes = Number(value ?? 0);

  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "unknown size";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
