<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import browser from "webextension-polyfill";
import { Crown, Download, ExternalLink, Satellite, Settings as SettingsIcon } from "@lucide/vue";
import { PREMIUM_ENABLED } from "@/config";
import { useI18n } from "./composables/useI18n";
import HeadTop from "./components/HeadTop.vue";
import PremiumPane from "./components/PremiumPane.vue";
import BatchDownload from "./components/BatchDownload.vue";
import ChannelPane from "./components/ChannelPane.vue";
import Settings from "./components/Settings.vue";
import FooterBottom from "./components/FooterBottom.vue";
import { usePremium } from "./composables/usePremium";
import { useTheme } from "./composables/useTheme";

type Tab = "download" | "channel" | "premium" | "settings";
const { t } = useI18n();

/** Computed so the tab labels re-render when the language changes. */
const tabs = computed<Array<{ id: Tab; label: string; icon: typeof Download; beta?: boolean }>>(() => [
  { id: "download", label: t("app.download"), icon: Download },
  { id: "channel", label: t("app.channel"), icon: Satellite, beta: true },
  ...(PREMIUM_ENABLED ? [{ id: "premium" as const, label: t("app.premium"), icon: Crown }] : []),
  { id: "settings", label: t("app.settings"), icon: SettingsIcon },
]);
const activeTab = ref<Tab>("download");
const notOnTelegram = ref(false);

const theme = useTheme();

function openTelegram(): void {
  void browser.tabs.create({ url: "https://web.telegram.org/a" });
}

/** Arrow-key navigation for the tab list; focus follows the selected tab. */
function onTabKeydown(event: KeyboardEvent): void {
  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
  event.preventDefault();
  const list = tabs.value;
  const index = list.findIndex((tab) => tab.id === activeTab.value);
  const delta = event.key === "ArrowRight" ? 1 : -1;
  const next = list[(index + delta + list.length) % list.length];
  if (!next) return;
  activeTab.value = next.id;
  void nextTick(() => {
    document.querySelector<HTMLButtonElement>(".tgdl-segmented [role='tab'][aria-selected='true']")?.focus();
  });
}

onMounted(async () => {
  void usePremium().refresh();
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  // Never navigate the user's current tab: opening the popup on an unrelated page used to destroy it.
  notOnTelegram.value = !tab?.url?.includes("web.telegram.org");
});
</script>

<template>
  <div id="main">
    <HeadTop :theme="theme.preference.value" @cycle-theme="theme.cycle" />

    <div v-if="notOnTelegram" class="tgdl-notice">
      <span>{{ t("app.notOnTelegram") }}</span>
      <el-button size="small" type="primary" @click="openTelegram"><ExternalLink :size="12" />{{ t("app.openTelegram") }}</el-button>
    </div>

    <div class="tgdl-card">
      <nav class="tgdl-segmented" role="tablist" :aria-label="t('app.sections')">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          role="tab"
          :aria-selected="activeTab === tab.id"
          :tabindex="activeTab === tab.id ? 0 : -1"
          :class="{ 'is-active': activeTab === tab.id }"
          @click="activeTab = tab.id"
          @keydown="onTabKeydown"
        >
          <component :is="tab.icon" :size="15" />{{ tab.label }}
          <span v-if="tab.beta" class="tgdl-beta-badge">{{ t("app.beta") }}</span>
        </button>
      </nav>

      <div class="tgdl-panel" role="tabpanel" :aria-label="activeTab">
        <!-- v-if, not v-show: a hidden pane must not keep page watches / storage listeners alive. -->
        <BatchDownload v-if="activeTab === 'download'" @upgrade="activeTab = 'premium'" />
        <ChannelPane v-if="activeTab === 'channel'" @upgrade="activeTab = 'premium'" />
        <PremiumPane v-if="PREMIUM_ENABLED && activeTab === 'premium'" />
        <Settings v-if="activeTab === 'settings'" />
      </div>
    </div>

    <FooterBottom />
  </div>
</template>

<style>
#main {
  width: 420px;
  padding: var(--space-lg) var(--space-lg) 0;
  box-sizing: border-box;
}
.tgdl-card {
  background: var(--color-canvas);
  border-radius: var(--radius-xl);
  overflow: hidden;
}
.tgdl-panel {
  min-height: 320px;
}
.tgdl-notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  margin-bottom: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  border-radius: var(--radius-md);
  background: var(--color-primary-pale);
  color: var(--color-ink);
  font-size: 12px;
}
.tgdl-notice .el-button { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; }
.tgdl-beta-badge {
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.04em;
  color: var(--color-positive-deep);
  background: var(--color-primary-pale);
  border-radius: var(--radius-sm);
  padding: 1px 4px;
  line-height: 1.4;
}
</style>
