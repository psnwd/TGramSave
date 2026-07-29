<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { Monitor, Moon, Sun } from "@lucide/vue";
import { getSettings, setSettings, type DownloadSettings, type ThemePreference } from "@/lib/storage";
import { useTheme } from "../composables/useTheme";

const defaultFolder = ref("");
const video = ref(true);
const image = ref(true);
const document_ = ref(false);
const showInlineButtons = ref(true);
const zipByDefault = ref(false);
const downloadWebm = ref(false);
const loaded = ref(false);

const theme = useTheme();
const themeOptions: Array<{ id: ThemePreference; label: string; icon: typeof Sun }> = [
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
  { id: "system", label: "System", icon: Monitor },
];

onMounted(async () => {
  const settings = await getSettings();
  defaultFolder.value = settings.defaultFolder;
  video.value = settings.video;
  image.value = settings.image;
  document_.value = settings.document;
  showInlineButtons.value = settings.showInlineButtons;
  zipByDefault.value = settings.zipByDefault;
  downloadWebm.value = settings.downloadWebm;
  loaded.value = true;
});

async function save(): Promise<void> {
  const settings: DownloadSettings = {
    defaultFolder: defaultFolder.value.trim(),
    video: video.value,
    image: image.value,
    document: document_.value,
    showInlineButtons: showInlineButtons.value,
    zipByDefault: zipByDefault.value,
    downloadWebm: downloadWebm.value,
    theme: theme.preference.value,
  };
  await setSettings(settings);
  ElMessage({ message: "Settings saved.", type: "success" });
}
</script>

<template>
  <div v-if="loaded" class="settings">
    <div class="field">
      <label>Appearance</label>
      <nav class="tgdl-segmented">
        <button
          v-for="option in themeOptions"
          :key="option.id"
          type="button"
          :class="{ 'is-active': theme.preference.value === option.id }"
          @click="theme.setPreference(option.id)"
        >
          <component :is="option.icon" :size="14" />{{ option.label }}
        </button>
      </nav>
    </div>

    <div class="field">
      <label>Default save folder</label>
      <el-input v-model="defaultFolder" placeholder="e.g. TelegramMedia" />
    </div>

    <div class="field">
      <label>Default media types (Channel download)</label>
      <div class="types">
        <el-checkbox v-model="video">Videos</el-checkbox>
        <el-checkbox v-model="image">Images</el-checkbox>
        <el-checkbox v-model="document_">Documents</el-checkbox>
      </div>
    </div>

    <div class="field">
      <el-checkbox v-model="showInlineButtons">Show an inline ⬇ download button on media messages</el-checkbox>
    </div>

    <div class="field">
      <el-checkbox v-model="downloadWebm">Also show the download button on GIFs and animated stickers (WebM)</el-checkbox>
      <p class="hint">Off by default — GIFs/stickers are usually decorative, not something you want to save.</p>
    </div>

    <div class="field">
      <el-checkbox v-model="zipByDefault">Zip downloads into one file by default</el-checkbox>
      <p class="hint">Applies to both the Download and Channel tabs. Zipping fetches every file into memory before
        saving, so very large batches will be slower and use more RAM than individual downloads.</p>
    </div>

    <el-button type="primary" @click="save">Save</el-button>
  </div>
</template>

<style scoped>
.settings { padding: var(--space-xl); }
.field { margin-bottom: var(--space-lg); }
.field label { display: block; font-size: 12px; font-weight: 600; color: var(--color-body); margin-bottom: var(--space-sm); }
.types { display: flex; gap: var(--space-md); }
/* theme.css's global `.el-checkbox` rule (width:100%, align-items:flex-start, wrapping label — meant for
   the full-width checkboxes below) also hit these compact inline ones, stretching each to the full row
   width and wrapping "Documents" onto two lines with the circle floating above it. Reset back to compact. */
.types :deep(.el-checkbox) {
  width: auto !important;
  height: 16px !important;
  align-items: center !important;
  white-space: nowrap !important;
  margin-right: 0;
}
.hint { font-size: 11px; color: var(--color-mute); margin: var(--space-xs) 0 0; }
</style>
