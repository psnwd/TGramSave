/**
 * Runs in the Telegram page's own (MAIN world) JS context — declared with
 * `world: "MAIN"` in the manifest so it can trigger same-origin `<a download>`
 * clicks against Telegram's blob/stream URLs.
 *
 * Probes for Range support, fetches in parallel chunks, reassembles into a
 * Blob and triggers a synthetic download. In "zip" mode, files are streamed
 * one at a time into a fflate Zip to avoid holding all bytes in memory at once.
 */
import { Zip, ZipDeflate } from "fflate";
import { uniqueZipEntryName } from "@/lib/zip";
import type { DownloadableItem, VideoDownloadEventDetail } from "@/types/messages";

const MAX_CONCURRENT_CHUNKS = 6;
const MAX_RETRIES_PER_CHUNK = 3;

function reportProgress(downloadId: string, progress: number): void {
  document.dispatchEvent(
    new CustomEvent(`${downloadId}_video_download_progress`, { detail: { progress, video_id: downloadId } }),
  );
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
  // Relay through background so chrome.downloads.download({saveAs:false}) can bypass the browser
  // "Ask where to save each file" setting. The isolated content script (channel-downloader) picks up
  // this event and forwards it; fall back to <a> click if not in channel-download context.
  document.dispatchEvent(new CustomEvent("tgdl_save_file", { detail: { url: objectUrl, filename } }));
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

type FetchedItem = { filename: string; blob: Blob };

/**
 * Sequential, cumulative, open-ended-Range fetch for `blob:` sources. Blob pseudo-URLs are backed by
 * the page's own in-memory stream, not an independent HTTP server — firing concurrent range requests
 * at one and trusting whatever comes back (in whatever order) produces a corrupted file. Each response's
 * `Content-Range` start must match the running byte offset exactly, or we bail out with a gap error
 * instead of silently assembling a broken blob.
 */
async function fetchBlobUrlBytes(item: DownloadableItem): Promise<FetchedItem> {
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

  const filename = guessFilename(item.videoUrl, extFromContentType(contentType) ?? "mp4");
  return { filename, blob: new Blob(chunks, { type: contentType || "application/octet-stream" }) };
}

/** Parallel range-chunked fetch for real network URLs, where the server can serve independent byte ranges concurrently. */
async function fetchNetworkUrlBytes(item: DownloadableItem): Promise<FetchedItem> {
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
  const supportsRange =
    acceptsRanges && probe.status === 206 && totalSize > 0 && segmentSize > 0 && segmentSize < totalSize;

  if (!supportsRange) {
    reportProgress(item.downloadId, 100);
    return { filename, blob: new Blob([probeBuf], { type: contentType || "application/octet-stream" }) };
  }

  const chunkCount = Math.ceil(totalSize / segmentSize);
  const chunks: ArrayBuffer[] = Array.from({ length: chunkCount });
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

  return { filename, blob: new Blob(chunks, { type: contentType || "application/octet-stream" }) };
}

/** Last-resort fallback: one plain GET, no Range header at all. */
async function fetchWholeFileBytes(item: DownloadableItem): Promise<FetchedItem> {
  const res = await fetch(item.videoUrl);
  if (!res.ok) throw new Error(`fallback fetch failed: ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "";
  const filename = guessFilename(item.videoUrl, extFromContentType(contentType) ?? "mp4");
  const blob = await res.blob();
  reportProgress(item.downloadId, 100);
  return { filename, blob };
}

/** Fetches one item without triggering a download. Branches on URL scheme. Falls back to plain fetch on error. */
async function fetchItemBlob(item: DownloadableItem): Promise<FetchedItem> {
  try {
    return await (item.videoUrl.startsWith("blob:") ? fetchBlobUrlBytes(item) : fetchNetworkUrlBytes(item));
  } catch (err) {
    console.error("[tgdl] range-aware fetch failed, falling back to plain fetch:", err);
    return fetchWholeFileBytes(item);
  }
}

async function downloadItem(item: DownloadableItem): Promise<void> {
  try {
    const { filename, blob } = await fetchItemBlob(item);
    triggerBlobDownload(blob, filename);
  } catch (err) {
    console.error("[tgdl] download failed:", item.videoUrl, err);
  }
}

function emitZipStatus(message: string): void {
  document.dispatchEvent(new CustomEvent("tgdl_zip_status", { detail: { message } }));
}

/** Fetches and zips items one at a time using fflate's streaming Zip to avoid holding all files in memory. */
// ponytail: ZipDeflate is synchronous; switch to AsyncZipDeflate if main-thread blocking on large files matters
async function downloadItemsAsZip(items: DownloadableItem[], zipName: string): Promise<void> {
  const usedNames = new Set<string>();
  const outChunks: Uint8Array[] = [];
  let added = 0;

  emitZipStatus(`Zipping 0/${items.length}…`);

  await new Promise<void>((resolve, reject) => {
    const z = new Zip((err, chunk, final) => {
      if (err) { reject(err); return; }
      outChunks.push(chunk);
      if (final) resolve();
    });

    (async () => {
      for (const item of items) {
        try {
          const { filename, blob } = await fetchItemBlob(item);
          const data = new Uint8Array(await blob.arrayBuffer());
          const entry = new ZipDeflate(uniqueZipEntryName(filename, usedNames), { level: 1 });
          z.add(entry);
          entry.push(data, true);
          added++;
          emitZipStatus(`Zipping ${added}/${items.length}…`);
        } catch (err) {
          console.error("[tgdl] zip: skipping item that failed to fetch", item.videoUrl, err);
        }
      }
      if (added === 0) {
        // No entries — end() may not fire the final callback; resolve manually.
        resolve();
        return;
      }
      z.end();
    })().catch(reject);
  });

  if (added === 0) {
    console.error("[tgdl] zip: all items failed to fetch — no zip saved");
    emitZipStatus("⚠ Zip failed — all items failed to fetch (check console)");
    return;
  }

  emitZipStatus(`Saving ${zipName}…`);
  triggerBlobDownload(
    new Blob(outChunks as unknown as BlobPart[], { type: "application/zip" }),
    zipName.endsWith(".zip") ? zipName : `${zipName}.zip`,
  );
  emitZipStatus(`✓ Zip saved: ${zipName}`);
}

// Guard: CRXJS may evaluate this module in the service worker context during build setup.
if (typeof document !== "undefined") {
  document.addEventListener("video_download", (event) => {
    const detail = (event as CustomEvent<VideoDownloadEventDetail>).detail;
    if (detail.type === "single") {
      void downloadItem(detail.item);
    } else if (detail.zip) {
      downloadItemsAsZip(detail.items, detail.zipName || "telegram_downloads.zip").catch((err) => {
        console.error("[tgdl] zip download failed:", err);
      });
    } else {
      for (const item of detail.items) void downloadItem(item);
    }
  });
}
