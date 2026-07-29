<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import browser from "webextension-polyfill";
import { ElMessage } from "element-plus";
import { CheckCircle2, Copy, Download, ImageIcon, RefreshCw, Trash2, Video } from "@lucide/vue";
import { hashTabUrl } from "@/lib/md5";
import { getActiveTelegramTab, onMessage, sendToActiveTab, sendToBackground } from "@/lib/messaging";
import { getSettings } from "@/lib/storage";
import type { DownloadableItem } from "@/types/messages";

interface Row extends DownloadableItem {
  progress: number;
}

const rows = reactive<Row[]>([]);
const selectedIds = reactive(new Set<string>());
const zipSelected = ref(false);
let storageKey = "";

const allSelected = computed(() => rows.length > 0 && selectedIds.size === rows.length);
const someSelected = computed(() => selectedIds.size > 0 && !allSelected.value);
const selection = computed(() => rows.filter((r) => selectedIds.has(r.downloadId)));

/** Only reached when catalog.ts couldn't capture a canvas thumbnail (e.g. a genuinely cross-origin source without CORS headers) — a type icon instead of a broken image. */
function mediaIcon(row: Row) {
  const kind = row.kind ?? (/\.(mp4|mov|webm)(\?|$)/.test(row.videoUrl) ? "video" : "image");
  return kind === "video" ? Video : ImageIcon;
}

/**
 * Merges the current stored list into `rows` in place instead of replacing the array — a plain
 * `splice(0, len, ...)` on every change (which is what content-script.ts's `videoCount` messages/storage
 * writes trigger continuously while browsing) reset every row's `.progress` and wiped `selectedIds` out
 * from under the user mid-selection. Existing rows get patched (keeping progress + selection), new items
 * are appended, and rows no longer present (e.g. after "Clear All") are dropped.
 */
function applyStoredList(list: Record<string, DownloadableItem>): void {
  const stillPresent = new Set(Object.keys(list));
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!stillPresent.has(rows[i]!.downloadId)) {
      selectedIds.delete(rows[i]!.downloadId);
      rows.splice(i, 1);
    }
  }

  for (const item of Object.values(list)) {
    const existing = rows.find((r) => r.downloadId === item.downloadId);
    if (existing) Object.assign(existing, item);
    else rows.push({ ...item, progress: 0 });
  }
}

async function loadRows(): Promise<void> {
  const tab = await getActiveTelegramTab();
  if (!tab?.url) return;
  storageKey = `${hashTabUrl(tab.url)}_video_list`;
  const stored = await browser.storage.local.get(storageKey);
  const list = (stored[storageKey] as Record<string, DownloadableItem> | undefined) ?? {};
  applyStoredList(list);
}

function toggleRow(row: Row): void {
  if (selectedIds.has(row.downloadId)) selectedIds.delete(row.downloadId);
  else selectedIds.add(row.downloadId);
}

function toggleAll(): void {
  if (allSelected.value) {
    selectedIds.clear();
  } else {
    rows.forEach((r) => selectedIds.add(r.downloadId));
  }
}

async function downloadOne(row: Row): Promise<void> {
  await sendToActiveTab({
    type: "singleDownloadPopup",
    videoUrl: row.videoUrl,
    videoId: row.videoId,
    page: "popup",
    downloadId: row.downloadId,
  });
}

async function downloadSelected(): Promise<void> {
  if (selection.value.length === 0) {
    ElMessage({ message: "Please select at least one file!", type: "warning" });
    return;
  }
  await sendToActiveTab({
    type: "batchDownloadPopup",
    items: selection.value.map((r) => ({ videoUrl: r.videoUrl, videoId: r.videoId, page: "popup", downloadId: r.downloadId })),
    zip: zipSelected.value,
    zipName: `telegram_downloads_${Date.now()}.zip`,
  });
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    ElMessage({ message: "Copy Success!", type: "success" });
  } catch {
    ElMessage({ message: "Copy Failed!", type: "warning" });
  }
}

function copySelected(): void {
  if (selection.value.length === 0) {
    ElMessage({ message: "Please select at least one file!", type: "warning" });
    return;
  }
  void copyToClipboard(selection.value.map((r) => r.videoUrl).join("\n"));
}

async function clearAll(): Promise<void> {
  if (!storageKey) return;
  await browser.storage.local.set({ [storageKey]: {} });
  rows.splice(0, rows.length);
  selectedIds.clear();
  await sendToBackground({ type: "clearVideoCount" });
}

async function forceDownload(): Promise<void> {
  await sendToActiveTab({ type: "forceDownloadPopup" });
  ElMessage({ message: "Re-scanning the page for media…", type: "info" });
  setTimeout(loadRows, 1000);
}

let unsubscribe: (() => void) | undefined;

/** Fires whenever catalog.ts (running in the Telegram tab, scanning every 3s) writes a newly-found item
 *  to storage — keeps the list live without the user having to reopen the popup or hit Force Download. */
function onStorageChanged(changes: Record<string, { newValue?: unknown }>, areaName: string): void {
  if (areaName !== "local" || !storageKey || !(storageKey in changes)) return;
  const list = (changes[storageKey]?.newValue as Record<string, DownloadableItem> | undefined) ?? {};
  applyStoredList(list);
}

onMounted(async () => {
  zipSelected.value = (await getSettings()).zipByDefault;
  void loadRows();
  unsubscribe = onMessage((message) => {
    if (message.type === "downloadProgress") {
      const row = rows.find((r) => r.downloadId === message.downloadId);
      if (row) row.progress = message.progress;
    }
  });
  browser.storage.onChanged.addListener(onStorageChanged);
});

onUnmounted(() => {
  unsubscribe?.();
  browser.storage.onChanged.removeListener(onStorageChanged);
});
</script>

<template>
  <div class="batch-download">
    <div v-if="rows.length > 0" class="list-header">
      <el-checkbox :model-value="allSelected" :indeterminate="someSelected" @change="toggleAll">
        {{ selectedIds.size > 0 ? `${selectedIds.size} selected` : "Select all" }}
      </el-checkbox>
    </div>

    <p v-if="rows.length === 0" class="empty">Browse messages in a chat — media will show up here.</p>

    <div v-else class="tgdl-list">
      <div
        v-for="(row, index) in rows"
        :key="row.downloadId"
        class="tgdl-list-item"
        :class="{ 'is-selected': selectedIds.has(row.downloadId) }"
      >
        <el-checkbox :model-value="selectedIds.has(row.downloadId)" @change="toggleRow(row)" />

        <div class="thumb">
          <img v-if="row.thumbnailDataUrl" class="thumb-media" :src="row.thumbnailDataUrl" alt="" />
          <component :is="mediaIcon(row)" v-else :size="18" />
        </div>

        <div class="meta">
          <span class="id">#{{ index + 1 }}</span>
          <el-progress v-if="row.progress > 0 && row.progress < 100" :percentage="row.progress" :stroke-width="4" />
          <span v-else-if="row.progress === 100" class="done"><CheckCircle2 :size="12" /> Downloaded</span>
        </div>

        <div class="row-actions">
          <el-button circle size="small" title="Download" @click="downloadOne(row)"><Download :size="14" /></el-button>
          <el-button circle size="small" title="Copy link" @click="copyToClipboard(row.videoUrl)"><Copy :size="14" /></el-button>
        </div>
      </div>
    </div>

    <el-checkbox v-model="zipSelected" class="zip-toggle">Zip into one file</el-checkbox>

    <div class="actions">
      <el-button type="primary" @click="downloadSelected"><Download :size="14" />Download Selected</el-button>
      <el-button @click="copySelected"><Copy :size="14" />Copy Selected</el-button>
      <el-button @click="forceDownload"><RefreshCw :size="14" />Force Download</el-button>
      <el-button type="danger" plain @click="clearAll"><Trash2 :size="14" />Clear All</el-button>
    </div>

    <p class="tip">Tip: open a chat and hover its media for a quick download button, or use Force Download to re-scan the page.</p>
  </div>
</template>

<style scoped>
.batch-download { padding: var(--space-xl); }
.list-header { margin-bottom: var(--space-sm); font-size: 13px; }
.empty { font-size: 13px; color: var(--color-mute); text-align: center; padding: var(--space-xl) 0; }
.tgdl-list { max-height: 260px; overflow-y: auto; scrollbar-gutter: stable; }
/*
 * theme.css sets a global `.el-checkbox { width: 100%; height: auto !important; align-items: flex-start
 * !important; ... }` for the full-width, wrapping-label checkboxes in Settings/ChannelPane. Applied here
 * too, that made this row-selector checkbox claim the entire row's width (flex-shrink:0 + width:100%),
 * pushing the thumbnail/meta/buttons outside the visible row — undo it back to a compact inline checkbox.
 */
.tgdl-list-item :deep(.el-checkbox) {
  width: auto !important;
  height: 16px !important;
  align-items: center !important;
  margin-right: 0;
  flex-shrink: 0;
}
.thumb {
  width: 40px;
  height: 40px;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
  background: var(--color-primary-pale);
  color: var(--color-positive-deep);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.thumb-media {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.id { font-size: 12px; font-weight: 600; color: var(--color-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.done { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--color-positive-deep); }
.row-actions { display: flex; gap: var(--space-xs); flex-shrink: 0; }
.zip-toggle { display: block; margin-top: var(--space-md); }
.actions { display: flex; gap: var(--space-sm); margin-top: var(--space-lg); flex-wrap: wrap; }
.actions .el-button { display: inline-flex; align-items: center; gap: 6px; }
.tip { font-size: 11px; color: var(--color-mute); margin-top: var(--space-md); }
</style>
