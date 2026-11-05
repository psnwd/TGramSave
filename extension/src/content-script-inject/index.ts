/**
 * Runs in the Telegram page's own (MAIN world) JS context — declared with
 * `world: "MAIN"` in the manifest so it can trigger same-origin `<a download>`
 * clicks against Telegram's blob/stream URLs.
 *
 * Probes for Range support, fetches in parallel chunks, reassembles into a
 * Blob and triggers a synthetic download. In "zip" mode, files are streamed
 * one at a time into a fflate Zip to avoid holding all bytes in memory at once.
 */
import { AsyncZipDeflate, Zip } from "fflate";
import { extensionFromContentType, safeZipEntryName, sanitizeFilename } from "@/lib/names";
import { backoffMs, parseContentRange, parseRetryAfter } from "@/lib/range";
import { isAllowedTelegramUrl } from "@/lib/urls";
import { uniqueZipEntryName } from "@/lib/zip";
import type { DownloadableItem, VideoDownloadEventDetail } from "@/types/messages";

const MAX_CONCURRENT_CHUNKS = 6;
const MAX_RETRIES_PER_CHUNK = 3;
/** A batch of 20 selections must not open 20 full-file fetches at once. */
const MAX_CONCURRENT_DOWNLOADS = 3;
/** fflate's ZIP writer is ZIP32; stay well under the 4 GiB limit and fail loudly instead of corrupting. */
const MAX_ZIP_BYTES = 2 * 1024 * 1024 * 1024;
/** Object URLs this module minted; used to refuse forged save events from the page. */
const createdObjectUrls = new Set<string>();

/** In-flight downloads, so the channel runner / popup can cancel them. */
const downloadControllers = new Map<string, AbortController>();

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException ? err.name === "AbortError" : err instanceof Error && err.name === "AbortError";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function reportError(downloadId: string, message: string): void {
  document.dispatchEvent(new CustomEvent("tgdl_download_error", { detail: { downloadId, message } }));
}

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
      if (payload?.fileName) return sanitizeFilename(payload.fileName, `tg_media.${ext}`);
      if (payload?.location?.id) return sanitizeFilename(`${payload.location.id}.${ext}`, `tg_media.${ext}`);
    } catch {
      // not JSON — fall through to a random name
    }
  }
  return `tg_${Date.now()}_${Math.round(Math.random() * 1e6)}.${ext}`;
}

async function fetchChunk(url: string, start: number, end: number, signal: AbortSignal): Promise<ArrayBuffer> {
  let lastError: unknown = new Error("chunk fetch failed");
  for (let attempt = 0; attempt < MAX_RETRIES_PER_CHUNK; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal });
    } catch (err) {
      if (isAbortError(err)) throw err;
      lastError = err;
      if (attempt < MAX_RETRIES_PER_CHUNK - 1) await sleep(backoffMs(attempt), signal);
      continue;
    }

    if (res.status === 206) {
      const range = parseContentRange(res.headers.get("content-range"));
      if (!range || range.start !== start || range.end !== end) {
        throw new Error(`chunk range mismatch: requested ${start}-${end}, got ${res.headers.get("content-range")}`);
      }
      try {
        return await res.arrayBuffer();
      } catch (err) {
        if (isAbortError(err)) throw err;
        lastError = err;
        if (attempt < MAX_RETRIES_PER_CHUNK - 1) await sleep(backoffMs(attempt), signal);
        continue;
      }
    }

    const retryable = res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500;
    if (!retryable) throw new Error(`chunk fetch failed: expected 206, got ${res.status}`);
    lastError = new Error(`chunk fetch failed: HTTP ${res.status}`);
    if (attempt < MAX_RETRIES_PER_CHUNK - 1) {
      await sleep(backoffMs(attempt, parseRetryAfter(res.headers.get("retry-after"))), signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("chunk fetch failed after retries");
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
  createdObjectUrls.add(objectUrl);

  let acknowledged = false;
  const cleanup = () => {
    document.removeEventListener("tgdl_save_file_ack", onAck);
    clearTimeout(timer);
  };
  const onAck = (event: Event) => {
    if ((event as CustomEvent<{ url?: string }>).detail?.url !== objectUrl) return;
    acknowledged = true;
    cleanup();
  };
  const timer = setTimeout(() => {
    if (acknowledged) return;
    cleanup();
    // No isolated-world listener (e.g. channel-downloader disabled): fall back to an <a download>
    // click. It can't bypass the browser's "Ask where to save" setting, but it does save the file.
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = sanitizeFilename(filename);
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }, 250);

  document.addEventListener("tgdl_save_file_ack", onAck);
  // Relay through background so chrome.downloads.download({saveAs:false}) can bypass the browser
  // "Ask where to save each file" setting. The isolated content script acknowledges it if present.
  document.dispatchEvent(new CustomEvent("tgdl_save_file", { detail: { url: objectUrl, filename } }));

  setTimeout(() => {
    createdObjectUrls.delete(objectUrl);
    URL.revokeObjectURL(objectUrl);
  }, 60_000);
}

type FetchedItem = { filename: string; blob: Blob };

/**
 * Sequential, cumulative, open-ended-Range fetch for `blob:` sources. Blob pseudo-URLs are backed by
 * the page's own in-memory stream, not an independent HTTP server — firing concurrent range requests
 * at one and trusting whatever comes back (in whatever order) produces a corrupted file. Each response's
 * `Content-Range` start must match the running byte offset exactly, or we bail out with a gap error
 * instead of silently assembling a broken blob.
 */
async function fetchBlobUrlBytes(item: DownloadableItem, signal: AbortSignal): Promise<FetchedItem> {
  const chunks: ArrayBuffer[] = [];
  let received = 0;
  let total = -1;
  let contentType = "";

  while (total < 0 || received < total) {
    const res = await fetch(item.videoUrl, { headers: { Range: `bytes=${received}-` }, signal });
    if (res.status !== 200 && res.status !== 206) {
      throw new Error(`blob fetch failed: ${res.status}`);
    }
    if (!contentType) contentType = res.headers.get("content-type") ?? "";

    const range = parseContentRange(res.headers.get("content-range"));
    if (range) {
      if (range.start !== received) throw new Error("Gap detected between responses.");
      if (range.total !== null) {
        if (total >= 0 && range.total !== total) throw new Error("Total size differs between responses.");
        total = range.total;
      }
    }

    const buf = await res.arrayBuffer();
    chunks.push(buf);
    received += buf.byteLength;

    if (total < 0) total = received; // no Content-Range at all — server gave us everything in one shot
    reportProgress(item.downloadId, total > 0 ? Math.round((received / total) * 100) : 100);
  }

  const filename = guessFilename(item.videoUrl, extensionFromContentType(contentType) ?? "mp4");
  return { filename, blob: new Blob(chunks, { type: contentType || "application/octet-stream" }) };
}

/** Parallel range-chunked fetch for real network URLs, where the server can serve independent byte ranges concurrently. */
async function fetchNetworkUrlBytes(item: DownloadableItem, signal: AbortSignal): Promise<FetchedItem> {
  const probe = await fetch(item.videoUrl, { headers: { Range: "bytes=0-" }, signal });
  const contentType = probe.headers.get("content-type") ?? "";
  const range = parseContentRange(probe.headers.get("content-range"));
  const filename = guessFilename(item.videoUrl, extensionFromContentType(contentType) ?? "mp4");
  const probeBuf = await probe.arrayBuffer();

  // A plain 200 means the server ignored Range, so the probe already is the whole file.
  if (probe.status === 200) {
    reportProgress(item.downloadId, 100);
    return { filename, blob: new Blob([probeBuf], { type: contentType || "application/octet-stream" }) };
  }

  // A 206 without a usable Content-Range total (`bytes 0-524287/*`) tells us a segment's size but not
  // whether it is the *last* segment. Treating the probe as complete here silently truncated files, so
  // re-fetch without Range instead of guessing.
  const totalSize = range?.total ?? null;
  if (probe.status !== 206 || !range || totalSize === null || range.start !== 0) {
    return fetchWholeFileBytes(item, signal);
  }

  // Telegram's CDN often caps even an open "bytes=0-" request to its own fixed segment size
  // instead of returning the whole file (observed: always 524288 bytes regardless of what's
  // asked for) — use however many bytes it actually sent as the per-request window for every
  // subsequent chunk, rather than an arbitrary client-chosen CHUNK_SIZE that the server ignores.
  const segmentSize = range.end - range.start + 1;
  if (segmentSize <= 0 || segmentSize !== probeBuf.byteLength) {
    return fetchWholeFileBytes(item, signal);
  }
  if (segmentSize >= totalSize) {
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
      chunks[chunkIndex] = await fetchChunk(item.videoUrl, start, end, signal);
      completed++;
      reportProgress(item.downloadId, Math.round((completed / chunkCount) * 100));
    },
  );

  return { filename, blob: new Blob(chunks, { type: contentType || "application/octet-stream" }) };
}

/** Last-resort fallback: one plain GET, no Range header at all. */
async function fetchWholeFileBytes(item: DownloadableItem, signal: AbortSignal): Promise<FetchedItem> {
  const res = await fetch(item.videoUrl, { signal });
  if (!res.ok) throw new Error(`fallback fetch failed: ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "";
  const filename = guessFilename(item.videoUrl, extensionFromContentType(contentType) ?? "mp4");
  const blob = await res.blob();
  reportProgress(item.downloadId, 100);
  return { filename, blob };
}

/** Fetches one item without triggering a download. Branches on URL scheme. Falls back to plain fetch on error. */
async function fetchItemBlob(item: DownloadableItem, signal: AbortSignal): Promise<FetchedItem> {
  try {
    return await (item.videoUrl.startsWith("blob:")
      ? fetchBlobUrlBytes(item, signal)
      : fetchNetworkUrlBytes(item, signal));
  } catch (err) {
    if (isAbortError(err)) throw err;
    console.error("[tgdl] range-aware fetch failed, falling back to plain fetch:", err);
    return fetchWholeFileBytes(item, signal);
  }
}

async function downloadItem(item: DownloadableItem): Promise<void> {
  const controller = new AbortController();
  downloadControllers.set(item.downloadId, controller);
  try {
    const { filename, blob } = await fetchItemBlob(item, controller.signal);
    triggerBlobDownload(blob, filename);
  } catch (err) {
    if (isAbortError(err)) {
      console.warn("[tgdl] download cancelled:", item.videoUrl);
      return;
    }
    console.error("[tgdl] download failed:", item.videoUrl, err);
    reportError(item.downloadId, err instanceof Error ? err.message : "Download failed");
  } finally {
    downloadControllers.delete(item.downloadId);
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
  let cancelled = false;

  emitZipStatus(`Zipping 0/${items.length}…`);

  await new Promise<void>((resolve, reject) => {
    const z = new Zip((err, chunk, final) => {
      if (err) {
        reject(err);
        return;
      }
      outChunks.push(chunk);
      if (final) resolve();
    });

    (async () => {
      let zipBytes = 0;
      for (const item of items) {
        const controller = new AbortController();
        downloadControllers.set(item.downloadId, controller);
        try {
          const { filename, blob } = await fetchItemBlob(item, controller.signal);
          const entry = new AsyncZipDeflate(uniqueZipEntryName(safeZipEntryName(filename), usedNames), { level: 0 });
          z.add(entry);

          // Stream the blob into the archive instead of materializing a second full copy per file.
          const reader = blob.stream().getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            zipBytes += value.byteLength;
            if (zipBytes > MAX_ZIP_BYTES) {
              cancelled = true;
              emitZipStatus("⚠ Zip too large — split it into smaller batches");
              await reader.cancel().catch(() => undefined);
              break;
            }
            entry.push(value, false);
          }
          if (cancelled) break;

          entry.push(new Uint8Array(0), true);
          added++;
          emitZipStatus(`Zipping ${added}/${items.length}…`);
        } catch (err) {
          if (isAbortError(err)) {
            cancelled = true;
            break;
          }
          console.error("[tgdl] zip: skipping item that failed to fetch", item.videoUrl, err);
          reportError(item.downloadId, err instanceof Error ? err.message : "Download failed");
        } finally {
          downloadControllers.delete(item.downloadId);
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

  if (cancelled) {
    emitZipStatus("⚠ Zip cancelled");
    return;
  }

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
    const accepted = (item: DownloadableItem): boolean => {
      if (isAllowedTelegramUrl(item.videoUrl)) return true;
      console.warn("[tgdl] refused a download request for a non-Telegram URL:", item.videoUrl);
      return false;
    };

    if (detail.type === "single") {
      if (accepted(detail.item)) void downloadItem(detail.item);
    } else if (detail.zip) {
      const items = detail.items.filter(accepted);
      if (items.length === 0) return;
      downloadItemsAsZip(items, detail.zipName || "telegram_downloads.zip").catch((err) => {
        console.error("[tgdl] zip download failed:", err);
      });
    } else {
      const items = detail.items.filter(accepted);
      void runPool(items, MAX_CONCURRENT_DOWNLOADS, (item) => downloadItem(item));
    }
  });

  // The isolated runner can't abort a fetch directly; it asks the page world to cancel by id (or all).
  document.addEventListener("tgdl_cancel_download", (event) => {
    const id = (event as CustomEvent<{ downloadId?: string }>).detail?.downloadId;
    if (id) downloadControllers.get(id)?.abort();
    else for (const controller of downloadControllers.values()) controller.abort();
  });
  document.addEventListener("tgdl_cancel_all", () => {
    for (const controller of downloadControllers.values()) controller.abort();
  });
}
