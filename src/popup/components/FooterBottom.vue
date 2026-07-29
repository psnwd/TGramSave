<script setup lang="ts">
import browser from "webextension-polyfill";
import { APP_NAME } from "@/config";

const version = browser.runtime.getManifest().version;
</script>

<template>
  <div class="footer">
    <span class="version">{{ APP_NAME }} v{{ version }}</span>
  </div>
</template>

<style scoped>
.footer {
  padding: var(--space-md) var(--space-sm);
  text-align: center;
  font-size: 11px;
  color: var(--color-mute);
}
</style>
