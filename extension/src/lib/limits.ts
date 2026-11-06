/** Pure channel-download limit/duration rules (kept out of the DOM module so they can be tested). */

export type MediaKind = "video" | "image" | "document";
export type MediaTypeFlags = Record<MediaKind, boolean>;
export type DispatchCounts = Record<MediaKind, number>;

export interface ChannelLimits {
  video: number;
  image: number;
  document: number;
  /** Cap on the combined count across every type. */
  total: number;
}

export const MEDIA_KINDS: readonly MediaKind[] = ["video", "image", "document"];

export function dispatchedTotal(counts: DispatchCounts): number {
  return counts.video + counts.image + counts.document;
}

/** This kind can't take any more (its own cap, or the total cap, is full). */
export function isKindCapReached(limits: ChannelLimits, counts: DispatchCounts, kind: MediaKind): boolean {
  if (limits.total > 0 && dispatchedTotal(counts) >= limits.total) return true;
  return limits[kind] > 0 && counts[kind] >= limits[kind];
}

/** Nothing left this run can do — the total cap is full, or every selected kind has hit its own cap. */
export function areAllCapsReached(limits: ChannelLimits, counts: DispatchCounts, types: MediaTypeFlags): boolean {
  if (limits.total > 0 && dispatchedTotal(counts) >= limits.total) return true;
  const selected = MEDIA_KINDS.filter((kind) => types[kind]);
  return selected.length > 0 && selected.every((kind) => limits[kind] > 0 && counts[kind] >= limits[kind]);
}

/** Unknown/zero duration is included (false negatives are worse than a few extra downloads). */
export function isDurationAllowed(durationSecs: number | undefined, minSecs: number, maxSecs: number): boolean {
  if (durationSecs === undefined || durationSecs <= 0) return true;
  if (minSecs > 0 && durationSecs < minSecs) return false;
  if (maxSecs > 0 && durationSecs > maxSecs) return false;
  return true;
}
