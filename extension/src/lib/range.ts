/** Pure helpers for byte-range downloads (kept DOM-free so they can be unit tested). */

export interface ParsedContentRange {
  start: number;
  end: number;
  /** null for the valid `bytes 0-9/*` form (segment size known, total unknown). */
  total: number | null;
}

/** Parses `Content-Range: bytes start-end/total`. Returns null when absent or malformed. */
export function parseContentRange(value: string | null): ParsedContentRange | null {
  if (!value) return null;
  const match = value.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === "*" ? null : Number(match[3]),
  };
}

/** `Retry-After` is seconds in practice for these CDNs; HTTP-date forms are ignored. */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/** Exponential backoff with jitter, honoring a server `Retry-After` when present. */
export function backoffMs(attempt: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds)) {
    return Math.min(30_000, retryAfterSeconds * 1000);
  }
  return Math.min(8_000, 500 * 2 ** attempt) + Math.round(Math.random() * 250);
}
