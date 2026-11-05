<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import browser from "webextension-polyfill";
import { Pause, Play, RefreshCw, Square, TriangleAlert } from "@lucide/vue";
import { onMessage } from "@/lib/messaging";
import { getCheckpoint, getSettings, setSettings } from "@/lib/storage";
import type { DownloadCheckpoint } from "@/lib/storage";
import type {
  ChannelDlCheckPageResponse,
  ChannelDlPeekResponse,
  ChannelDlStatusResponse,
  ChannelDownloadLimits,
  ChannelDownloadOptions,
} from "@/types/messages";
import { useI18n } from "../composables/useI18n";
import { usePremium } from "../composables/usePremium";

const emit = defineEmits<{ upgrade: [] }>();
const { deny } = usePremium();
const { t } = useI18n();

const status = ref("Checking page…");
const found = ref(0);
const downloaded = ref(0);
const running = ref(false);
const paused = ref(false);
const refreshing = ref(false);
const notOnTelegram = ref(false);
const permissionMissing = ref(false);
const channelTitle = ref("");
const folder = ref("");
const includeVideo = ref(true);
const includeImage = ref(true);
const includeDocument = ref(false);
const zip = ref(false);
const zipBatchSize = ref("");
const checkpointEvery = ref("");
const savedCheckpoint = ref<DownloadCheckpoint | null>(null);
let currentChannelKey = "";

// Per-type + total caps, held as the raw input string. "" = no limit (input shows its "All" placeholder).
const videoLimit = ref("");
const imageLimit = ref("");
const documentLimit = ref("");
const totalLimit = ref("");

// Video duration filter, in seconds. "" = no filter.
const minVideoSecs = ref("");
const maxVideoSecs = ref("");

/** Keep only digits, drop leading zeros, cap length — so the field can't hold anything but a plain count. */
function sanitizeLimit(v: string): string {
  return v.replace(/\D/g, "").replace(/^0+(?=\d)/, "").slice(0, 6);
}
/** Input string -> a positive integer cap, or 0 for "no limit". */
function toCap(v: string): number {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const limitSummary = computed(() => {
  const parts: string[] = [];
  if (toCap(videoLimit.value)) parts.push(t("channel.countVideo", { n: toCap(videoLimit.value) }));
  if (toCap(imageLimit.value)) parts.push(t("channel.countImage", { n: toCap(imageLimit.value) }));
  if (toCap(documentLimit.value)) parts.push(t("channel.countDocument", { n: toCap(documentLimit.value) }));
  if (toCap(totalLimit.value)) parts.push(t("channel.countTotal", { n: toCap(totalLimit.value) }));
  return parts.length ? t("channel.limitSummary", { parts: parts.join(" · ") }) : t("channel.noLimit");
});

function currentLimits(): ChannelDownloadLimits {
  return {
    video: toCap(videoLimit.value),
    image: toCap(imageLimit.value),
    document: toCap(documentLimit.value),
    total: toCap(totalLimit.value),
  };
}

let activeTabId: number | undefined;

async function hasDownloadsPermission(): Promise<boolean> {
  try {
    await browser.downloads.search({ limit: 1 });
    return true;
  } catch {
    return false;
  }
}

/** Same 6s safety net added this session: a silent stall anywhere in the chain surfaces a message instead of hanging on "Checking page…" forever. */
async function checkPage(): Promise<void> {
  status.value = t("channel.checking");
  found.value = 0;
  downloaded.value = 0;

  let settled = false;
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    status.value = t("channel.noResponse");
  }, 6000);
  const finish = (message: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    status.value = message;
  };

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes("web.telegram.org")) {
    notOnTelegram.value = true;
    finish(t("channel.statusNotOnTelegram"));
    return;
  }
  notOnTelegram.value = false;
  activeTabId = tab.id;

  if (!(await hasDownloadsPermission())) {
    permissionMissing.value = true;
    finish(`⚠ ${t("channel.permissionMissing")}`);
    return;
  }
  permissionMissing.value = false;

  try {
    const pageInfo = (await browser.tabs.sendMessage(tab.id!, { type: "channel_dl_check_page" })) as
      | ChannelDlCheckPageResponse
      | undefined;
    if (!pageInfo) {
      finish(t("channel.couldNotReach"));
      return;
    }
    channelTitle.value = pageInfo.channelTitle;
    currentChannelKey = pageInfo.channelKey;
    savedCheckpoint.value = currentChannelKey ? await getCheckpoint(currentChannelKey) : null;
    finish(t("channel.ready"));
  } catch {
    finish(t("channel.couldNotReach"));
    return;
  }

  try {
    const statusInfo = (await browser.tabs.sendMessage(tab.id!, { type: "channel_dl_get_status" })) as
      | ChannelDlStatusResponse
      | undefined;
    if (statusInfo?.running) {
      running.value = true;
      paused.value = statusInfo.paused;
      found.value = statusInfo.found;
      downloaded.value = statusInfo.downloaded;
      finish(statusInfo.paused ? t("channel.paused") : t("channel.running"));
      return;
    }
  } catch {
    // best-effort — the check_page response above already settled the status
  }

  // Not running yet — show a real "currently visible" count instead of a stale 0.
  await peek();
}

/** Non-destructive re-scan: counts media already visible in the DOM without starting a download run. */
async function peek(): Promise<void> {
  if (!activeTabId || running.value) return;
  refreshing.value = true;
  try {
    const result = (await browser.tabs.sendMessage(activeTabId, {
      type: "channel_dl_peek",
      mediaTypes: { video: includeVideo.value, image: includeImage.value, document: includeDocument.value },
    })) as ChannelDlPeekResponse | undefined;
    if (result) found.value = result.found;
  } catch {
    // page may have navigated away — checkPage()'s own error handling covers that path
  } finally {
    refreshing.value = false;
  }
}

async function refresh(): Promise<void> {
  if (running.value) {
    await peek();
    return;
  }
  await checkPage();
}

/** Opens (or updates) the content script's throttled scroll watcher so "Found" tracks manual scrolling. */
function watchVisibleCount(): void {
  if (!activeTabId) return;
  void browser.tabs
    .sendMessage(activeTabId, {
      type: "channel_dl_watch",
      mediaTypes: { video: includeVideo.value, image: includeImage.value, document: includeDocument.value },
    })
    .catch(() => undefined);
}

function unwatchVisibleCount(): void {
  if (!activeTabId) return;
  void browser.tabs.sendMessage(activeTabId, { type: "channel_dl_unwatch" }).catch(() => undefined);
}

async function start(resume = false): Promise<void> {
  if (!activeTabId) return;
  const reason = deny("channel");
  if (reason) {
    status.value = `⭐ ${reason}`;
    emit("upgrade");
    return;
  }
  if (!includeVideo.value && !includeImage.value && !includeDocument.value) {
    status.value = t("channel.selectMediaType");
    return;
  }
  running.value = true;
  paused.value = false;
  found.value = 0;
  downloaded.value = 0;
  status.value = t("channel.starting");

  const limits = currentLimits();
  const videoDuration = { min: toCap(minVideoSecs.value), max: toCap(maxVideoSecs.value) };
  const options: ChannelDownloadOptions = {
    folder: folder.value.trim(),
    video: includeVideo.value,
    image: includeImage.value,
    document: includeDocument.value,
    zip: zip.value,
    zipBatchSize: toCap(zipBatchSize.value),
    checkpointEvery: toCap(checkpointEvery.value),
    resume,
    limits,
    minVideoSecs: videoDuration.min,
    maxVideoSecs: videoDuration.max,
  };
  // Remember the caps and duration filter for next time.
  void getSettings().then((s) => setSettings({ ...s, channelLimits: limits, channelVideoDuration: videoDuration, channelZipBatchSize: toCap(zipBatchSize.value), channelCheckpointEvery: toCap(checkpointEvery.value) })).catch(() => undefined);
  if (!resume) savedCheckpoint.value = null;
  await browser.tabs.sendMessage(activeTabId, { type: "channel_dl_start", options });
}

async function stop(): Promise<void> {
  if (!activeTabId) return;
  await browser.tabs.sendMessage(activeTabId, { type: "channel_dl_stop" });
}

async function togglePause(): Promise<void> {
  if (!activeTabId) return;
  await browser.tabs.sendMessage(activeTabId, { type: paused.value ? "channel_dl_resume" : "channel_dl_pause" });
}

let unsubscribe: (() => void) | undefined;

onMounted(async () => {
  const settings = await getSettings();
  folder.value = settings.defaultFolder;
  includeVideo.value = settings.video;
  includeImage.value = settings.image;
  includeDocument.value = settings.document;
  zip.value = settings.zipByDefault;
  zipBatchSize.value = settings.channelZipBatchSize ? String(settings.channelZipBatchSize) : "";
  checkpointEvery.value = settings.channelCheckpointEvery ? String(settings.channelCheckpointEvery) : "";
  const l = settings.channelLimits;
  videoLimit.value = l.video ? String(l.video) : "";
  imageLimit.value = l.image ? String(l.image) : "";
  documentLimit.value = l.document ? String(l.document) : "";
  totalLimit.value = l.total ? String(l.total) : "";
  const d = settings.channelVideoDuration;
  minVideoSecs.value = d.min ? String(d.min) : "";
  maxVideoSecs.value = d.max ? String(d.max) : "";

  await checkPage();
  watchVisibleCount();

  unsubscribe = onMessage((message) => {
    if (message.type === "channel_dl_found") {
      if (!running.value) found.value = message.found;
      return;
    }
    if (message.type !== "channel_dl_status") return;
    status.value = message.message;
    found.value = message.found;
    downloaded.value = message.downloaded;
    running.value = message.running;
    paused.value = message.paused;
    if (message.done) running.value = false;
  });
});

// Checkboxes changed — re-scope the live count (and the on-demand peek) to the new media types.
watch([includeVideo, includeImage, includeDocument], () => {
  if (running.value) return;
  watchVisibleCount();
  void peek();
});

onUnmounted(() => {
  unsubscribe?.();
  unwatchVisibleCount();
});
</script>

<template>
  <div class="channel-pane">
    <p class="beta-note"><TriangleAlert :size="14" /> {{ t("channel.beta") }}</p>
    <p v-if="notOnTelegram" class="warning"><TriangleAlert :size="14" /> {{ t("channel.notOnTelegram") }}</p>
    <p v-if="permissionMissing" class="warning"><TriangleAlert :size="14" /> {{ t("channel.permissionMissing") }}</p>
    <p v-if="channelTitle" class="channel-name">{{ t("channel.title", { name: channelTitle }) }}</p>

    <div class="field">
      <label>{{ t("channel.saveFolder") }}</label>
      <el-input v-model="folder" :placeholder="t('channel.saveFolderPlaceholder')" />
    </div>

    <div class="field limits">
      <label>{{ t("channel.mediaTypesLimits") }} <span class="opt">{{ t("channel.blankDownloadAll") }}</span></label>
      <div class="limit-grid" :class="{ 'is-locked': running }">
        <div class="limit-row">
          <el-checkbox v-model="includeVideo" :disabled="running">{{ t("channel.videos") }}</el-checkbox>
          <el-input
            :model-value="videoLimit" size="small" :placeholder="t('channel.all')" clearable inputmode="numeric"
            :disabled="running || !includeVideo"
            @update:model-value="videoLimit = sanitizeLimit($event)"
          />
        </div>
        <div class="limit-row">
          <el-checkbox v-model="includeImage" :disabled="running">{{ t("channel.images") }}</el-checkbox>
          <el-input
            :model-value="imageLimit" size="small" :placeholder="t('channel.all')" clearable inputmode="numeric"
            :disabled="running || !includeImage"
            @update:model-value="imageLimit = sanitizeLimit($event)"
          />
        </div>
        <div class="limit-row">
          <el-checkbox v-model="includeDocument" :disabled="running">{{ t("channel.documents") }}</el-checkbox>
          <el-input
            :model-value="documentLimit" size="small" :placeholder="t('channel.all')" clearable inputmode="numeric"
            :disabled="running || !includeDocument"
            @update:model-value="documentLimit = sanitizeLimit($event)"
          />
        </div>
        <div class="limit-row total">
          <span class="total-label">{{ t("channel.totalCap") }}</span>
          <el-input
            :model-value="totalLimit" size="small" :placeholder="t('channel.all')" clearable inputmode="numeric"
            :disabled="running"
            @update:model-value="totalLimit = sanitizeLimit($event)"
          />
        </div>
      </div>
      <p class="limit-summary">{{ limitSummary }}</p>
    </div>

    <div v-if="includeVideo" class="field duration-field">
      <label>{{ t("channel.durationFilter") }}</label>
      <div class="duration-row">
        <span class="dur-label">{{ t("channel.min") }}</span>
        <el-input
          :model-value="minVideoSecs" size="small" :placeholder="t('channel.any')" clearable inputmode="numeric"
          :disabled="running"
          @update:model-value="minVideoSecs = sanitizeLimit($event)"
        />
        <span class="dur-label">{{ t("channel.max") }}</span>
        <el-input
          :model-value="maxVideoSecs" size="small" :placeholder="t('channel.any')" clearable inputmode="numeric"
          :disabled="running"
          @update:model-value="maxVideoSecs = sanitizeLimit($event)"
        />
      </div>
      <p v-if="toCap(minVideoSecs) || toCap(maxVideoSecs)" class="limit-summary">
        <template v-if="toCap(minVideoSecs) && toCap(maxVideoSecs)">
          {{ t("channel.durationBetween", { min: toCap(minVideoSecs), max: toCap(maxVideoSecs) }) }}
        </template>
        <template v-else-if="toCap(minVideoSecs)">{{ t("channel.durationMin", { min: toCap(minVideoSecs) }) }}</template>
        <template v-else>{{ t("channel.durationMax", { max: toCap(maxVideoSecs) }) }}</template>
        <span class="opt"> · {{ t("channel.durationUnknown") }}</span>
      </p>
    </div>

    <div class="zip-row">
      <el-checkbox v-model="zip" :disabled="running">{{ t("channel.zipWhenDone") }}</el-checkbox>
      <template v-if="zip">
        <el-input
          :model-value="zipBatchSize" size="small" :placeholder="t('channel.allInOne')" clearable inputmode="numeric"
          class="zip-batch-input" :disabled="running"
          @update:model-value="zipBatchSize = sanitizeLimit($event)"
        /><span class="zip-batch-label">{{ t("channel.filesPerZip") }}</span>
      </template>
    </div>

    <div class="checkpoint-row">
      <span class="checkpoint-label">{{ t("channel.checkpointEvery") }}</span>
      <el-input
        :model-value="checkpointEvery" size="small" :placeholder="t('channel.off')" clearable inputmode="numeric"
        class="checkpoint-input" :disabled="running"
        @update:model-value="checkpointEvery = sanitizeLimit($event)"
      />
      <span class="checkpoint-label">{{ t("channel.files") }}</span>
    </div>

    <div v-if="savedCheckpoint && !running" class="resume-banner">
      <span>{{ t("channel.checkpointSummary", { downloaded: savedCheckpoint.totalDownloaded, time: new Date(savedCheckpoint.savedAt).toLocaleTimeString() }) }}</span>
      <div class="resume-actions">
        <el-button size="small" type="primary" @click="start(true)"><Play :size="12" />{{ t("channel.resume") }}</el-button>
        <el-button size="small" @click="savedCheckpoint = null">{{ t("channel.discard") }}</el-button>
      </div>
    </div>

    <div class="actions">
      <el-button type="primary" :disabled="running || notOnTelegram" @click="start"><Play :size="14" />{{ t("channel.start") }}</el-button>
      <el-button v-if="running" @click="togglePause">
        <component :is="paused ? Play : Pause" :size="14" />{{ paused ? t("channel.resume") : t("channel.pause") }}
      </el-button>
      <el-button v-if="running" type="danger" plain @click="stop"><Square :size="14" />{{ t("channel.stop") }}</el-button>
    </div>

    <div class="status-box">
      <div class="status-text">{{ status }}</div>
      <div class="counts-row">
        <span class="counts">{{ t("channel.found") }}: {{ found }} &nbsp;&nbsp; {{ t("channel.downloadedCount") }}: {{ downloaded }}</span>
        <button
          type="button"
          class="refresh-btn"
          :disabled="refreshing || notOnTelegram"
          :title="t('channel.reScan')"
          :aria-label="t('channel.reScan')"
          @click="refresh"
        >
          <RefreshCw :size="13" :class="{ spinning: refreshing }" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.channel-pane { padding: var(--space-xl); }
.warning {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  color: var(--color-negative-deep);
  background: var(--color-negative-bg);
  border-radius: var(--radius-sm);
  padding: var(--space-sm) var(--space-md);
  font-size: 12px;
  margin-bottom: var(--space-sm);
}
.warning svg { flex-shrink: 0; }
.beta-note {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  color: var(--color-mute);
  background: var(--color-canvas-soft);
  border-radius: var(--radius-sm);
  padding: var(--space-sm) var(--space-md);
  font-size: 12px;
  margin-bottom: var(--space-sm);
}
.beta-note svg { flex-shrink: 0; }
.channel-name {
  display: inline-block;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-ink);
  background: var(--color-primary-pale);
  border-radius: var(--radius-pill);
  padding: var(--space-xxs) var(--space-md);
  margin-bottom: var(--space-md);
}
.field { margin-bottom: var(--space-lg); }
.field label { display: block; font-size: 12px; color: var(--color-body); margin-bottom: var(--space-xs); font-weight: 600; }
.field label .opt { font-weight: 400; color: var(--color-mute); }

.limit-grid {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--color-canvas);
}
.limit-grid.is-locked { opacity: 0.6; }
.limit-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
}
.limit-row + .limit-row { border-top: 1px solid var(--color-border); }
.limit-row.total {
  border-top: 1px solid var(--color-border);
  background: var(--color-canvas-soft);
}
.limit-row.total .total-label { font-size: 12px; font-weight: 600; color: var(--color-body); }
/* Same fix as Settings.vue: theme.css's global `.el-checkbox` rule stretches compact checkboxes full-width. */
.limit-row :deep(.el-checkbox) {
  width: auto !important;
  height: 16px !important;
  align-items: center !important;
  white-space: nowrap !important;
  margin-right: 0;
}
.limit-row :deep(.el-input) { width: 96px; flex-shrink: 0; }
.limit-row :deep(.el-input__inner) { text-align: right; }
.limit-summary {
  margin: var(--space-xs) 0 0;
  font-size: 11px;
  color: var(--color-mute);
}

.duration-field { margin-bottom: var(--space-lg); }
.duration-row {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-canvas);
}
.duration-row :deep(.el-input) { width: 80px; flex-shrink: 0; }
.duration-row :deep(.el-input__inner) { text-align: right; }
.dur-label { font-size: 12px; font-weight: 600; color: var(--color-body); white-space: nowrap; }
.zip-row { display: flex; align-items: center; gap: 8px; margin-bottom: var(--space-md); flex-wrap: wrap; }
.zip-batch-input { width: 90px; }
.zip-batch-label { font-size: 12px; color: var(--el-text-color-secondary); white-space: nowrap; }
.checkpoint-row { display: flex; align-items: center; gap: 8px; margin-bottom: var(--space-lg); flex-wrap: wrap; }
.checkpoint-input { width: 80px; }
.checkpoint-label { font-size: 12px; color: var(--el-text-color-secondary); white-space: nowrap; }
.resume-banner {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;
  padding: var(--space-sm) var(--space-md);
  background: var(--color-primary-pale);
  border-radius: var(--radius-md);
  margin-bottom: var(--space-lg);
  font-size: 12px;
  color: var(--color-ink);
}
.resume-actions { display: flex; gap: 6px; flex-shrink: 0; }
.actions { display: flex; gap: var(--space-sm); margin-bottom: var(--space-lg); flex-wrap: wrap; }
.actions .el-button { display: inline-flex; align-items: center; gap: 6px; }
.status-box { padding: var(--space-md); background: var(--color-canvas-soft); border-radius: var(--radius-md); font-size: 12px; }
.status-text { color: var(--color-ink); font-weight: 600; margin-bottom: var(--space-xs); }
.counts-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); }
.counts { color: var(--color-mute); }
.refresh-btn {
  border: none;
  background: var(--color-canvas);
  color: var(--color-ink);
  width: 24px;
  height: 24px;
  border-radius: var(--radius-pill);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
}
.refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.refresh-btn :deep(.spinning) { animation: tgdl-spin 0.8s linear infinite; }
@keyframes tgdl-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
