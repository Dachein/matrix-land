import type { ReactNode } from "react";
import { mateFileReferenceFromUrl } from "../../../../src/shared/mateFileReference.js";

export function MateFileLink({ children, fileName, onOpen, url }: {
  children?: ReactNode;
  fileName: string;
  onOpen?: (url: string, fileName: string) => void;
  url: string;
}) {
  const reference = mateFileReferenceFromUrl(url, fileName);
  if (!reference || !onOpen) return <span>{children ?? fileName}</span>;
  return <a href={reference.url} onClick={(event) => {
    event.preventDefault();
    onOpen(reference.url, reference.fileName);
  }}>{children ?? fileName}</a>;
}
