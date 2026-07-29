<script setup lang="ts">
import { onMounted, ref } from "vue";
import browser from "webextension-polyfill";
import { Download, Satellite, Settings as SettingsIcon } from "@lucide/vue";
import HeadTop from "./components/HeadTop.vue";
import BatchDownload from "./components/BatchDownload.vue";
import ChannelPane from "./components/ChannelPane.vue";
import Settings from "./components/Settings.vue";
import FooterBottom from "./components/FooterBottom.vue";
import { useTheme } from "./composables/useTheme";

type Tab = "download" | "channel" | "settings";
const tabs: Array<{ id: Tab; label: string; icon: typeof Download; beta?: boolean }> = [
  { id: "download", label: "Download", icon: Download },
  { id: "channel", label: "Channel", icon: Satellite, beta: true },
  { id: "settings", label: "Settings", icon: SettingsIcon },
];
const activeTab = ref<Tab>("download");

const theme = useTheme();

onMounted(async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id && !tab.url?.includes("web.telegram.org/")) {
    await browser.tabs.update(tab.id, { url: "https://web.telegram.org/a" });
  }
});
</script>

<template>
  <div id="main">
    <HeadTop :theme="theme.preference.value" @cycle-theme="theme.cycle" />

    <div class="tgdl-card">
      <nav class="tgdl-segmented">
        <button v-for="tab in tabs" :key="tab.id" type="button" :class="{ 'is-active': activeTab === tab.id }" @click="activeTab = tab.id">
          <component :is="tab.icon" :size="15" />{{ tab.label }}
          <span v-if="tab.beta" class="tgdl-beta-badge">BETA</span>
        </button>
      </nav>

      <div class="tgdl-panel">
        <BatchDownload v-show="activeTab === 'download'" />
        <ChannelPane v-show="activeTab === 'channel'" />
        <Settings v-show="activeTab === 'settings'" />
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
