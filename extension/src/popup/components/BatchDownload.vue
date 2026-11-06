<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import browser from "webextension-polyfill";
import { ElMessage } from "element-plus";
import { CheckCircle2, Copy, Download, ImageIcon, RefreshCw, Trash2, Video } from "@lucide/vue";
import { hashTabUrl } from "@/lib/md5";
import { getActiveTelegramTab, onMessage, sendToActiveTab, sendToBackground } from "@/lib/messaging";
import { getSettings } from "@/lib/storage";
import type { DownloadKind } from "@/lib/premium";
import type { DownloadableItem } from "@/types/messages";
import { useI18n } from "../composables/useI18n";
import { usePremium } from "../composables/usePremium";

const emit = defineEmits<{ upgrade: [] }>();
const { deny } = usePremium();
const { t } = useI18n();

/** Popup-side pre-check (the content script enforces + counts); warns and jumps to the Premium tab. */
function blocked(kind: DownloadKind): boolean {
  const reason = deny(kind);
  if (!reason) return false;
  ElMessage({ message: reason, type: "warning" });
  emit("upgrade");
  return true;
}

interface Row extends DownloadableItem {
  progress: number;
  error?: string;
}

const rows = reactive<Row[]>([]);
/** O(1) lookup for the per-item merge; `rows.find` made a 1,000-item refresh quadratic. */
const rowById = new Map<string, Row>();
const selectedIds = reactive(new Set<string>());
const zipSelected = ref(false);
const downloading = ref(false);
let storageKey = "";

const allSelected = computed(() => rows.length > 0 && selectedIds.size === rows.length);
const someSelected = computed(() => selectedIds.size > 0 && !allSelected.value);
const selection = computed(() => rows.filter((r) => selectedIds.has(r.downloadId)));

/** 0–100 across the selected rows; a failed row counts as finished so the run can end. */
const overallProgress = computed(() => {
  if (selection.value.length === 0) return 0;
  const finished = selection.value.reduce(
    (sum, row) => sum + (row.progress >= 100 || row.error ? 100 : row.progress),
    0,
  );
  return Math.min(100, Math.round(finished / selection.value.length));
});

watch(overallProgress, (progress) => {
  if (downloading.value && progress >= 100) downloading.value = false;
});

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
    const row = rows[i]!;
    if (!stillPresent.has(row.downloadId)) {
      selectedIds.delete(row.downloadId);
      rowById.delete(row.downloadId);
      rows.splice(i, 1);
    }
  }

  for (const item of Object.values(list)) {
    const existing = rowById.get(item.downloadId);
    if (existing) {
      Object.assign(existing, item);
    } else {
      const row: Row = { ...item, progress: 0 };
      rowById.set(item.downloadId, row);
      rows.push(row);
    }
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
  if (blocked("single")) return;
  row.error = undefined;
  row.progress = 0;
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
    ElMessage({ message: t("download.selectOne"), type: "warning" });
    return;
  }
  if (blocked(selection.value.length > 1 || zipSelected.value ? "batch" : "single")) return;
  for (const row of selection.value) {
    row.error = undefined;
    row.progress = 0;
  }
  downloading.value = true;
  try {
    await sendToActiveTab({
      type: "batchDownloadPopup",
      items: selection.value.map((r) => ({ videoUrl: r.videoUrl, videoId: r.videoId, page: "popup", downloadId: r.downloadId })),
      zip: zipSelected.value,
      zipName: `telegram_downloads_${Date.now()}.zip`,
    });
  } catch {
    downloading.value = false;
    ElMessage({ message: t("download.couldNotReach"), type: "error" });
  }
}

async function cancelDownloads(): Promise<void> {
  await sendToActiveTab({ type: "cancelDownloads" }).catch(() => undefined);
  downloading.value = false;
  ElMessage({ message: t("download.cancelling"), type: "info" });
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    ElMessage({ message: t("download.copySuccess"), type: "success" });
  } catch {
    ElMessage({ message: t("download.copyFailed"), type: "warning" });
  }
}

function copySelected(): void {
  if (selection.value.length === 0) {
    ElMessage({ message: t("download.selectOne"), type: "warning" });
    return;
  }
  void copyToClipboard(selection.value.map((r) => r.videoUrl).join("\n"));
}

async function clearAll(): Promise<void> {
  if (!storageKey) return;
  // Tell the page to stop re-cataloguing what we're about to delete; otherwise the next 3s scan
  // repopulates the list and "Clear All" looks broken.
  const ids = rows.map((row) => row.videoId);
  await sendToActiveTab({ type: "catalog_suppress", ids }).catch(() => undefined);
  await browser.storage.local.set({ [storageKey]: {} });
  rows.splice(0, rows.length);
  rowById.clear();
  selectedIds.clear();
  await sendToBackground({ type: "clearVideoCount" });
  ElMessage({ message: t("download.cleared"), type: "success" });
}

async function forceDownload(): Promise<void> {
  await sendToActiveTab({ type: "forceDownloadPopup" });
  ElMessage({ message: t("download.rescanning"), type: "info" });
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
      const row = rowById.get(message.downloadId);
      if (row) row.progress = message.progress;
      return;
    }
    if (message.type === "downloadError") {
      const row = rowById.get(message.downloadId);
      if (row) {
        row.progress = 0;
        row.error = message.message;
      }
      ElMessage({ message: t("download.errorToast", { message: message.message }), type: "error" });
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
        {{ selectedIds.size > 0 ? t("download.selected", { n: selectedIds.size }) : t("download.selectAll") }}
      </el-checkbox>
    </div>

    <p v-if="rows.length === 0" class="empty">{{ t("download.empty") }}</p>

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
          <span v-else-if="row.progress === 100" class="done"><CheckCircle2 :size="12" /> {{ t("download.downloaded") }}</span>
          <span v-else-if="row.error" class="error" :title="row.error">{{ t("download.failed", { message: row.error }) }}</span>
        </div>

        <div class="row-actions">
          <el-button circle size="small" :title="t('download.downloadThis')" :aria-label="t('download.downloadThis')" @click="downloadOne(row)"><Download :size="14" /></el-button>
          <el-button circle size="small" :title="t('download.copyLink')" :aria-label="t('download.copyLink')" @click="copyToClipboard(row.videoUrl)"><Copy :size="14" /></el-button>
        </div>
      </div>
    </div>

    <el-checkbox v-model="zipSelected" class="zip-toggle">{{ t("download.zip") }}</el-checkbox>

    <div v-if="downloading" class="overall">
      <el-progress :percentage="overallProgress" :stroke-width="6" />
      <el-button size="small" type="danger" plain @click="cancelDownloads">{{ t("download.cancel") }}</el-button>
    </div>

    <div class="actions">
      <el-button type="primary" :disabled="downloading" @click="downloadSelected"><Download :size="14" />{{ t("download.selectedAction") }}</el-button>
      <el-button @click="copySelected"><Copy :size="14" />{{ t("download.copySelected") }}</el-button>
      <el-button @click="forceDownload"><RefreshCw :size="14" />{{ t("download.force") }}</el-button>
      <el-button type="danger" plain @click="clearAll"><Trash2 :size="14" />{{ t("download.clear") }}</el-button>
    </div>

    <p class="tip">{{ t("download.tip") }}</p>
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
.error { font-size: 11px; color: var(--color-negative-deep); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-actions { display: flex; gap: var(--space-xs); flex-shrink: 0; }
.zip-toggle { display: block; margin-top: var(--space-md); }
.overall { display: flex; align-items: center; gap: var(--space-sm); margin-top: var(--space-md); }
.overall :deep(.el-progress) { flex: 1; }
.actions { display: flex; gap: var(--space-sm); margin-top: var(--space-lg); flex-wrap: wrap; }
.actions .el-button { display: inline-flex; align-items: center; gap: 6px; }
.tip { font-size: 11px; color: var(--color-mute); margin-top: var(--space-md); }
</style>
