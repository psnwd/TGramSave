<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { Monitor, Moon, Sun } from "@lucide/vue";
import { getSettings, setSettings, type DownloadSettings, type ThemePreference } from "@/lib/storage";
import { useI18n } from "../composables/useI18n";
import { useTheme } from "../composables/useTheme";

const { t, locales, setLocale } = useI18n();
const defaultFolder = ref("");
const language = ref("system");
const video = ref(true);
const image = ref(true);
const document_ = ref(false);
const showInlineButtons = ref(true);
const buttonsOnPreviews = ref(false);
const zipByDefault = ref(false);
const downloadWebm = ref(false);
const loaded = ref(false);

const theme = useTheme();
const themeOptions = computed<Array<{ id: ThemePreference; label: string; icon: typeof Sun }>>(() => [
  { id: "light", label: t("theme.light"), icon: Sun },
  { id: "dark", label: t("theme.dark"), icon: Moon },
  { id: "system", label: t("theme.system"), icon: Monitor },
]);

async function changeLanguage(value: string): Promise<void> {
  language.value = value;
  setLocale(value);
  const settings = await getSettings();
  await setSettings({ ...settings, language: value });
}

onMounted(async () => {
  const settings = await getSettings();
  defaultFolder.value = settings.defaultFolder;
  video.value = settings.video;
  image.value = settings.image;
  document_.value = settings.document;
  showInlineButtons.value = settings.showInlineButtons;
  buttonsOnPreviews.value = settings.buttonsOnPreviews;
  zipByDefault.value = settings.zipByDefault;
  downloadWebm.value = settings.downloadWebm;
  language.value = settings.language;
  loaded.value = true;
});

async function save(): Promise<void> {
  // Spread the stored settings first so fields this screen doesn't edit (e.g. the Channel tab's
  // `channelLimits`) are preserved rather than dropped.
  const settings: DownloadSettings = {
    ...(await getSettings()),
    defaultFolder: defaultFolder.value.trim(),
    video: video.value,
    image: image.value,
    document: document_.value,
    showInlineButtons: showInlineButtons.value,
    buttonsOnPreviews: buttonsOnPreviews.value,
    zipByDefault: zipByDefault.value,
    downloadWebm: downloadWebm.value,
    theme: theme.preference.value,
    language: language.value,
  };
  await setSettings(settings);
  ElMessage({ message: t("settings.saved"), type: "success" });
}
</script>

<template>
  <div v-if="loaded" class="settings">
    <div class="field">
      <label>{{ t("settings.appearance") }}</label>
      <nav class="tgdl-segmented">
        <button
          v-for="option in themeOptions"
          :key="option.id"
          type="button"
          :class="{ 'is-active': theme.preference.value === option.id }"
          :aria-pressed="theme.preference.value === option.id"
          @click="theme.setPreference(option.id)"
        >
          <component :is="option.icon" :size="14" />{{ option.label }}
        </button>
      </nav>
    </div>

    <div class="field">
      <label>{{ t("settings.language") }}</label>
      <el-select :model-value="language" size="small" @update:model-value="changeLanguage">
        <el-option value="system" :label="t('settings.systemLanguage')" />
        <el-option v-for="option in locales" :key="option.code" :value="option.code" :label="option.label" />
      </el-select>
      <p class="hint">{{ t("settings.languageHint") }}</p>
    </div>

    <div class="field">
      <label>{{ t("settings.defaultFolder") }}</label>
      <el-input v-model="defaultFolder" :placeholder="t('settings.folderPlaceholder')" />
    </div>

    <div class="field">
      <label>{{ t("settings.defaultMediaTypes") }}</label>
      <div class="types">
        <el-checkbox v-model="video">{{ t("channel.videos") }}</el-checkbox>
        <el-checkbox v-model="image">{{ t("channel.images") }}</el-checkbox>
        <el-checkbox v-model="document_">{{ t("channel.documents") }}</el-checkbox>
      </div>
    </div>

    <div class="field">
      <el-checkbox v-model="showInlineButtons">{{ t("settings.inlineButtons") }}</el-checkbox>
    </div>

    <div class="field">
      <el-checkbox v-model="buttonsOnPreviews" :disabled="!showInlineButtons">
        {{ t("settings.previews") }}
      </el-checkbox>
      <p class="hint">{{ t("settings.previewsHint") }}</p>
    </div>

    <div class="field">
      <el-checkbox v-model="downloadWebm" :disabled="!showInlineButtons">{{ t("settings.webm") }}</el-checkbox>
      <p class="hint">{{ t("settings.webmHint") }}</p>
    </div>

    <div class="field">
      <el-checkbox v-model="zipByDefault">{{ t("settings.zipDefault") }}</el-checkbox>
      <p class="hint">{{ t("settings.zipHint") }}</p>
    </div>

    <el-button type="primary" @click="save">{{ t("settings.save") }}</el-button>
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
