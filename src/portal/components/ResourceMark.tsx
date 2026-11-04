import { useState, type HTMLAttributes, type ReactNode } from "react";

/** A failed cover or avatar keeps its identity and retries when its URL changes. */
export function ResourceMark({ imageUrl, fallback, ...props }: HTMLAttributes<HTMLSpanElement> & {
  imageUrl?: string;
  fallback: ReactNode;
}) {
  const url = imageUrl?.trim();
  const [failedUrl, setFailedUrl] = useState<string>();
  return <span {...props}>
    {url && url !== failedUrl
      ? <img alt="" draggable={false} onError={() => setFailedUrl(url)} src={url} />
      : fallback}
  </span>;
}
