/**
 * Runs in the Telegram page's own (MAIN world) JS context — injected as a
 * <script src> tag by content-script/index.ts, since isolated-world content
 * scripts can't trigger a same-origin `<a download>` click reliably against
 * Telegram's blob/stream URLs.
 *
 * Clean re-implementation of the original parallel byte-range downloader:
 * probes whether the server supports `Range` requests, then fetches the file
 * in parallel chunks (falling back to a single plain fetch when it doesn't),
 * reassembles it into a Blob, and triggers a synthetic download. In "zip"
 * mode, every item's bytes are fetched into memory first and bundled into a
 * single archive instead of downloading each file individually.
 */
import { buildZip, toBlob, uniqueZipEntryName } from "@/lib/zip";
import type { DownloadableItem, VideoDownloadEventDetail } from "@/types/messages";

const MAX_CONCURRENT_CHUNKS = 6;
const MAX_RETRIES_PER_CHUNK = 3;

function reportProgress(downloadId: string, progress: number): void {
  document.dispatchEvent(new CustomEvent(`${downloadId}_video_download_progress`, { detail: { progress, video_id: downloadId } }));
}

/** Telegram media URLs sometimes carry a `stream/<json>` payload with a real filename/location id. */
function guessFilename(url: string, ext = "mp4"): string {
  const streamMatch = url.match(/stream\/([^/]+)/);
  if (streamMatch?.[1]) {
    try {
      const payload = JSON.parse(decodeURIComponent(streamMatch[1]));
      if (payload?.fileName) return payload.fileName;
      if (payload?.location?.id) return `${payload.location.id}.${ext}`;
    } catch {
      // not JSON — fall through to a random name
    }
  }
  return `tg_${Date.now()}_${Math.round(Math.random() * 1e6)}.${ext}`;
}

/** Parses a `Content-Range: bytes start-end/total` header value. Returns null if absent/malformed. */
function parseContentRange(value: string | null): { start: number; end: number; total: number } | null {
  if (!value) return null;
  const m = value.match(/bytes\s+(\d+)-(\d+)\/(\d+)/);
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) };
}

function extFromContentType(contentType: string | null | undefined): string | undefined {
  if (!contentType) return undefined;
  const subtype = (contentType.split(";")[0] ?? "").split("/")[1];
  return subtype || undefined;
}

async function fetchChunk(url: string, start: number, end: number): Promise<ArrayBuffer> {
  for (let attempt = 0; attempt < MAX_RETRIES_PER_CHUNK; attempt++) {
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
    if (res.status === 408) continue; // request timeout — retry
    if (res.status !== 206) throw new Error(`chunk fetch failed: expected 206, got ${res.status}`);
    const range = parseContentRange(res.headers.get("content-range"));
    if (!range || range.start !== start || range.end !== end) {
      throw new Error(`chunk range mismatch: requested ${start}-${end}, got ${res.headers.get("content-range")}`);
    }
    return res.arrayBuffer();
  }
  throw new Error("chunk fetch failed after retries");
}

async function runPool<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  async function runNext(): Promise<void> {
    const index = next++;
    const item = items[index];
    if (item === undefined) return;
    await worker(item, index);
    await runNext();
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
}

type FetchedBytes = { filename: string; data: Uint8Array; contentType: string };

/**
 * Sequential, cumulative, open-ended-Range fetch for `blob:` sources. Blob pseudo-URLs are backed by
 * the page's own in-memory stream, not an independent HTTP server — firing concurrent range requests
 * at one and trusting whatever comes back (in whatever order) produces a corrupted file. Each response's
 * `Content-Range` start must match the running byte offset exactly, or we bail out with a gap error
 * instead of silently assembling a broken blob.
 */
async function fetchBlobUrlBytes(item: DownloadableItem): Promise<FetchedBytes> {
  const chunks: ArrayBuffer[] = [];
  let received = 0;
  let total = -1;
  let contentType = "";

  while (total < 0 || received < total) {
    const res = await fetch(item.videoUrl, { headers: { Range: `bytes=${received}-` } });
    if (res.status !== 200 && res.status !== 206) {
      throw new Error(`blob fetch failed: ${res.status}`);
    }
    if (!contentType) contentType = res.headers.get("content-type") ?? "";

    const range = parseContentRange(res.headers.get("content-range"));
    if (range) {
      if (range.start !== received) throw new Error("Gap detected between responses.");
      if (total >= 0 && range.total !== total) throw new Error("Total size differs between responses.");
      total = range.total;
    }

    const buf = await res.arrayBuffer();
    chunks.push(buf);
    received += buf.byteLength;

    if (total < 0) total = received; // no Content-Range at all — server gave us everything in one shot
    reportProgress(item.downloadId, total > 0 ? Math.round((received / total) * 100) : 100);
  }

  const data = new Uint8Array(await new Blob(chunks).arrayBuffer());
  const filename = guessFilename(item.videoUrl, extFromContentType(contentType) ?? "mp4");
  return { filename, data, contentType: contentType || "application/octet-stream" };
}

/** Parallel range-chunked fetch for real network URLs, where the server can serve independent byte ranges concurrently. */
async function fetchNetworkUrlBytes(item: DownloadableItem): Promise<FetchedBytes> {
  const probe = await fetch(item.videoUrl, { headers: { Range: "bytes=0-" } });
  const contentType = probe.headers.get("content-type") ?? "";
  const acceptsRanges = probe.headers.get("accept-ranges") === "bytes";
  const range = parseContentRange(probe.headers.get("content-range"));
  const totalSize = range?.total ?? Number(probe.headers.get("content-length") ?? 0);
  const filename = guessFilename(item.videoUrl, extFromContentType(contentType) ?? "mp4");
  const probeBuf = await probe.arrayBuffer();

  // Telegram's CDN often caps even an open "bytes=0-" request to its own fixed segment size
  // instead of returning the whole file (observed: always 524288 bytes regardless of what's
  // asked for) — use however many bytes it actually sent as the per-request window for every
  // subsequent chunk, rather than an arbitrary client-chosen CHUNK_SIZE that the server ignores.
  const segmentSize = range ? range.end - range.start + 1 : probeBuf.byteLength;
  const supportsRange = acceptsRanges && probe.status === 206 && totalSize > 0 && segmentSize > 0 && segmentSize < totalSize;

  if (!supportsRange) {
    reportProgress(item.downloadId, 100);
    return { filename, data: new Uint8Array(probeBuf), contentType: contentType || "application/octet-stream" };
  }

  const chunkCount = Math.ceil(totalSize / segmentSize);
  const chunks: ArrayBuffer[] = new Array(chunkCount);
  chunks[0] = probeBuf; // the probe request already fetched segment 0 — don't re-fetch it
  let completed = 1;
  reportProgress(item.downloadId, Math.round((completed / chunkCount) * 100));

  await runPool(
    Array.from({ length: chunkCount - 1 }, (_, i) => i + 1),
    MAX_CONCURRENT_CHUNKS,
    async (chunkIndex) => {
      const start = chunkIndex * segmentSize;
      const end = Math.min(start + segmentSize - 1, totalSize - 1);
      chunks[chunkIndex] = await fetchChunk(item.videoUrl, start, end);
      completed++;
      reportProgress(item.downloadId, Math.round((completed / chunkCount) * 100));
    },
  );

  const data = new Uint8Array(await new Blob(chunks).arrayBuffer());
  return { filename, data, contentType: contentType || "application/octet-stream" };
}

/** Last-resort fallback: one plain GET, no Range header at all. A normal HTTP GET always returns the
 *  full entity, so this can't produce a gap/mismatch — used when the smarter range-aware paths fail. */
async function fetchWholeFileBytes(item: DownloadableItem): Promise<FetchedBytes> {
  const res = await fetch(item.videoUrl);
  if (!res.ok) throw new Error(`fallback fetch failed: ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "";
  const filename = guessFilename(item.videoUrl, extFromContentType(contentType) ?? "mp4");
  const data = new Uint8Array(await res.arrayBuffer());
  reportProgress(item.downloadId, 100);
  return { filename, data, contentType: contentType || "application/octet-stream" };
}

/** Fetches one item's full bytes without triggering a download. Branches on URL scheme: `blob:` sources
 *  need sequential cumulative fetching, real network URLs can be range-chunked in parallel. Either path
 *  falls back to a single plain fetch on failure — better a corrupted-but-present file (or a fully
 *  correct one, since a plain GET usually returns the whole entity) than downloading nothing at all. */
async function fetchItemBytes(item: DownloadableItem): Promise<FetchedBytes> {
  try {
    return await (item.videoUrl.startsWith("blob:") ? fetchBlobUrlBytes(item) : fetchNetworkUrlBytes(item));
  } catch (err) {
    console.error("[tgdl] range-aware fetch failed, falling back to plain fetch:", err);
    return fetchWholeFileBytes(item);
  }
}

async function downloadItem(item: DownloadableItem): Promise<void> {
  try {
    const { filename, data, contentType } = await fetchItemBytes(item);
    triggerBlobDownload(toBlob(data, contentType), filename);
  } catch (err) {
    console.error("[tgdl] download failed:", item.videoUrl, err);
  }
}

async function downloadItemsAsZip(items: DownloadableItem[], zipName: string): Promise<void> {
  const files: Record<string, Uint8Array> = {};
  const usedNames = new Set<string>();

  for (const item of items) {
    const { filename, data } = await fetchItemBytes(item);
    files[uniqueZipEntryName(filename, usedNames)] = data;
  }

  const zipped = await buildZip(files);
  triggerBlobDownload(toBlob(zipped, "application/zip"), zipName.endsWith(".zip") ? zipName : `${zipName}.zip`);
}

document.addEventListener("video_download", (event) => {
  const detail = (event as CustomEvent<VideoDownloadEventDetail>).detail;
  if (detail.type === "single") {
    void downloadItem(detail.item);
  } else if (detail.zip) {
    void downloadItemsAsZip(detail.items, detail.zipName || "telegram_downloads.zip");
  } else {
    for (const item of detail.items) void downloadItem(item);
  }
});
