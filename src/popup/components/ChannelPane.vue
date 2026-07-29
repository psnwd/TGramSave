<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import browser from "webextension-polyfill";
import { Pause, Play, RefreshCw, Square, TriangleAlert } from "@lucide/vue";
import { onMessage } from "@/lib/messaging";
import { getSettings } from "@/lib/storage";
import type {
  ChannelDlCheckPageResponse,
  ChannelDlPeekResponse,
  ChannelDlStatusResponse,
  ChannelDownloadOptions,
} from "@/types/messages";

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
  status.value = "Checking page…";
  found.value = 0;
  downloaded.value = 0;

  let settled = false;
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    status.value = "No response from page — try reloading the Telegram tab";
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
    finish("Not on Telegram");
    return;
  }
  notOnTelegram.value = false;
  activeTabId = tab.id;

  if (!(await hasDownloadsPermission())) {
    permissionMissing.value = true;
    finish("⚠ Downloads permission missing");
    return;
  }
  permissionMissing.value = false;

  try {
    const pageInfo = (await browser.tabs.sendMessage(tab.id!, { type: "channel_dl_check_page" })) as
      | ChannelDlCheckPageResponse
      | undefined;
    if (!pageInfo) {
      finish("Could not reach page — reload Telegram");
      return;
    }
    channelTitle.value = pageInfo.channelTitle;
    finish("Ready");
  } catch {
    finish("Could not reach page — reload Telegram");
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
      finish(statusInfo.paused ? "Paused" : "Running…");
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

async function start(): Promise<void> {
  if (!activeTabId) return;
  if (!includeVideo.value && !includeImage.value && !includeDocument.value) {
    status.value = "⚠ Select at least one media type";
    return;
  }
  running.value = true;
  paused.value = false;
  found.value = 0;
  downloaded.value = 0;
  status.value = "Starting…";

  const options: ChannelDownloadOptions = {
    folder: folder.value.trim(),
    video: includeVideo.value,
    image: includeImage.value,
    document: includeDocument.value,
    zip: zip.value,
  };
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

  void checkPage();
  unsubscribe = onMessage((message) => {
    if (message.type !== "channel_dl_status") return;
    status.value = message.message;
    found.value = message.found;
    downloaded.value = message.downloaded;
    running.value = message.running;
    paused.value = message.paused;
    if (message.done) running.value = false;
  });
});

onUnmounted(() => unsubscribe?.());
</script>

<template>
  <div class="channel-pane">
    <p class="beta-note"><TriangleAlert :size="14" /> Beta — whole-channel download is still being worked on and may be unreliable on large chats.</p>
    <p v-if="notOnTelegram" class="warning"><TriangleAlert :size="14" /> Open web.telegram.org and select a chat first.</p>
    <p v-if="permissionMissing" class="warning"><TriangleAlert :size="14" /> Downloads permission is missing — reinstall the extension.</p>
    <p v-if="channelTitle" class="channel-name">Channel: {{ channelTitle }}</p>

    <div class="field">
      <label>Save folder (optional)</label>
      <el-input v-model="folder" placeholder="e.g. TelegramMedia" />
    </div>

    <div class="types">
      <el-checkbox v-model="includeVideo">Videos</el-checkbox>
      <el-checkbox v-model="includeImage">Images</el-checkbox>
      <el-checkbox v-model="includeDocument">Documents</el-checkbox>
    </div>

    <el-checkbox v-model="zip" class="zip-toggle" :disabled="running">Zip into one file when done</el-checkbox>

    <div class="actions">
      <el-button type="primary" :disabled="running || notOnTelegram" @click="start"><Play :size="14" />Start</el-button>
      <el-button v-if="running" @click="togglePause">
        <component :is="paused ? Play : Pause" :size="14" />{{ paused ? "Resume" : "Pause" }}
      </el-button>
      <el-button type="danger" plain :disabled="!running" @click="stop"><Square :size="14" />Stop</el-button>
    </div>

    <div class="status-box">
      <div class="status-text">{{ status }}</div>
      <div class="counts-row">
        <span class="counts">Found: {{ found }} &nbsp;&nbsp; Downloaded: {{ downloaded }}</span>
        <button type="button" class="refresh-btn" :disabled="refreshing || notOnTelegram" title="Re-scan the page" @click="refresh">
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
.types { display: flex; gap: var(--space-md); margin-bottom: var(--space-md); }
/* Same fix as Settings.vue: theme.css's global `.el-checkbox` rule (width:100%, align-items:flex-start)
   stretched each of these compact inline checkboxes to the full row width, wrapping "Documents" onto two
   lines with the circle floating above it instead of sitting next to the label. */
.types :deep(.el-checkbox) {
  width: auto !important;
  height: 16px !important;
  align-items: center !important;
  white-space: nowrap !important;
  margin-right: 0;
}
.zip-toggle { display: block; margin-bottom: var(--space-lg); }
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
