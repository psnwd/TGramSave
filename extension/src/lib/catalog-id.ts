import { hashValue } from "./md5";

/**
 * A stable id for a media item: `messageId_index` survives Telegram re-renders (which hand the same
 * message a fresh `blob:` src), while the src hash is only a fallback when there is no message id.
 */
export function catalogId(src: string, mid: string | undefined, index: number): string {
  return mid ? `${mid}_${index}` : hashValue(src).slice(0, 12);
}
