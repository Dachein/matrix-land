import { Image } from "@tarojs/components";
import bookOpen from "../assets/book-open.png";

export function KnowledgeIcon({ className = "" }: { className?: string }) {
  return <Image className={className} mode="aspectFit" src={bookOpen} />;
}
